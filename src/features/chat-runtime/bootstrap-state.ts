import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  DATA_DIR,
  STORE_DIR,
  MAIN_GROUP_FOLDER,
} from '../../app/config.js';
import { AvailableGroup } from '../execution/container-runner.js';
import {
  deleteSession,
  ensureUserHomeGroup,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getLastGroupSync,
  getRegisteredGroup,
  getRouterState,
  getRouterStateByPrefix,
  listUsers,
  setRegisteredGroup,
  setRouterState,
} from '../../db.js';
import { imManager } from '../im/im-manager.js';
import { logger } from '../../app/logger.js';
import {
  getFeishuProviderConfigWithSource,
  getTelegramProviderConfigWithSource,
  getUserFeishuConfig,
  getUserTelegramConfig,
  saveUserFeishuConfig,
  saveUserTelegramConfig,
} from '../../runtime-config.js';
import type {
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
} from '../../shared/types.js';
import { normalizeCursor } from './recovery.js';

export const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface CreateIndexStateBootstrapDeps {
  getGlobalMessageCursor: () => MessageCursor;
  setGlobalMessageCursor: (cursor: MessageCursor) => void;
  lastAgentTimestamp: Record<string, MessageCursor>;
  lastCommittedCursor: Record<string, MessageCursor>;
  sessions: Record<string, RuntimeSessionRecord>;
  registeredGroups: Record<string, RegisteredGroup>;
  consecutiveOomExits: Record<string, number>;
}

interface IndexStateBootstrap {
  getAvailableGroups: () => AvailableGroup[];
  loadState: () => void;
  migrateDataDirectories: () => void;
  migrateSystemIMToPerUser: () => void;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  saveState: () => void;
  syncGroupMetadata: (force?: boolean) => Promise<void>;
}

export function createBootstrapStateRuntime(
  deps: CreateIndexStateBootstrapDeps,
): IndexStateBootstrap {
  const {
    getGlobalMessageCursor,
    setGlobalMessageCursor,
    lastAgentTimestamp,
    lastCommittedCursor,
    sessions,
    registeredGroups,
    consecutiveOomExits,
  } = deps;

  const saveState = (): void => {
    const globalMessageCursor = getGlobalMessageCursor();
    setRouterState('last_timestamp', globalMessageCursor.timestamp);
    setRouterState('last_timestamp_id', globalMessageCursor.id);
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
    setRouterState(
      'last_committed_cursor',
      JSON.stringify(lastCommittedCursor),
    );
  };

  const registerGroup = (jid: string, group: RegisteredGroup): void => {
    registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);

    const groupDir = path.join(GROUPS_DIR, group.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group registered',
    );
  };

  const getAvailableGroups = (): AvailableGroup[] => {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(registeredGroups));

    return chats
      .filter((c) => c.jid !== '__group_sync__' && c.jid.startsWith('feishu:'))
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  };

  const syncGroupMetadata = async (force = false): Promise<void> => {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        const now = Date.now();
        if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    const connectedUserIds = imManager.getConnectedUserIds();
    for (const uid of connectedUserIds) {
      if (imManager.isFeishuConnected(uid)) {
        await imManager.syncFeishuGroups(uid);
        break;
      }
    }
  };

  const loadState = (): void => {
    const persistedTimestamp = getRouterState('last_timestamp') || '';
    const lastTimestampId = getRouterState('last_timestamp_id') || '';
    setGlobalMessageCursor({
      timestamp: persistedTimestamp,
      id: lastTimestampId,
    });

    const loadCursorMap = (key: string): Record<string, MessageCursor> => {
      const raw = getRouterState(key);
      try {
        const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const normalized: Record<string, MessageCursor> = {};
        for (const [jid, value] of Object.entries(parsed)) {
          normalized[jid] = normalizeCursor(value);
        }
        return normalized;
      } catch {
        logger.warn(`Corrupted ${key} in DB, resetting`);
        return {};
      }
    };

    Object.keys(lastAgentTimestamp).forEach((key) => {
      delete lastAgentTimestamp[key];
    });
    Object.assign(lastAgentTimestamp, loadCursorMap('last_agent_timestamp'));

    Object.keys(lastCommittedCursor).forEach((key) => {
      delete lastCommittedCursor[key];
    });
    Object.assign(lastCommittedCursor, loadCursorMap('last_committed_cursor'));

    let migratedMissingCommittedCursor = false;
    for (const [jid, cursor] of Object.entries(lastAgentTimestamp)) {
      if (!lastCommittedCursor[jid]) {
        lastCommittedCursor[jid] = cursor;
        migratedMissingCommittedCursor = true;
      }
    }
    if (migratedMissingCommittedCursor) {
      logger.info(
        'Migrated missing lastCommittedCursor entries from lastAgentTimestamp',
      );
      saveState();
    }

    Object.keys(sessions).forEach((key) => {
      delete sessions[key];
    });
    Object.assign(sessions, getAllSessions());

    Object.keys(registeredGroups).forEach((key) => {
      delete registeredGroups[key];
    });
    Object.assign(registeredGroups, getAllRegisteredGroups());

    for (const { key, value } of getRouterStateByPrefix('oom_exits:')) {
      const folder = key.slice('oom_exits:'.length);
      const count = parseInt(value, 10);
      if (count > 0) {
        consecutiveOomExits[folder] = count;
        logger.info({ folder, count }, 'Restored OOM counter from DB');
      }
    }

    const defaultGroupsPath = path.resolve(
      process.cwd(),
      'config',
      'default-groups.json',
    );
    if (fs.existsSync(defaultGroupsPath)) {
      try {
        const defaults = JSON.parse(
          fs.readFileSync(defaultGroupsPath, 'utf-8'),
        ) as Array<{
          jid: string;
          name: string;
          folder: string;
        }>;
        for (const group of defaults) {
          if (!registeredGroups[group.jid]) {
            registerGroup(group.jid, {
              name: group.name,
              folder: group.folder,
              added_at: new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to load default groups config');
      }
    }

    try {
      const activeUsers: Array<{ id: string; role: string; username: string }> =
        [];
      let page = 1;
      while (true) {
        const result = listUsers({ status: 'active', page, pageSize: 200 });
        activeUsers.push(...result.users);
        if (activeUsers.length >= result.total) break;
        page++;
      }

      for (const user of activeUsers) {
        const homeJid = ensureUserHomeGroup(
          user.id,
          user.role as 'admin' | 'member',
          user.username,
        );
        const freshGroup = getRegisteredGroup(homeJid);
        if (freshGroup) {
          registeredGroups[homeJid] = freshGroup;
        } else if (!registeredGroups[homeJid]) {
          Object.keys(registeredGroups).forEach((key) => {
            delete registeredGroups[key];
          });
          Object.assign(registeredGroups, getAllRegisteredGroups());
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to ensure user home groups');
    }

    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (!group.is_home) continue;

      const isAdminHome = group.folder === MAIN_GROUP_FOLDER;
      const expectedMode = isAdminHome ? 'host' : 'container';

      if (group.executionMode !== expectedMode) {
        group.executionMode = expectedMode;
        setRegisteredGroup(jid, group);
        registeredGroups[jid] = group;
        if (sessions[group.folder]) {
          logger.info(
            { folder: group.folder, expectedMode },
            'Clearing stale session during execution mode migration',
          );
          delete sessions[group.folder];
          deleteSession(group.folder);
        }
      }
    }

    const templatePath = path.resolve(
      process.cwd(),
      'config',
      'global-agents-md.template.md',
    );
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, 'utf-8');
      const userGlobalBase = path.join(GROUPS_DIR, 'user-global');
      try {
        let page = 1;
        const allUsers: Array<{ id: string }> = [];
        while (true) {
          const result = listUsers({ status: 'active', page, pageSize: 200 });
          allUsers.push(...result.users);
          if (allUsers.length >= result.total) break;
          page++;
        }
        for (const user of allUsers) {
          const userDir = path.join(userGlobalBase, user.id);
          fs.mkdirSync(userDir, { recursive: true });
          const userMemoryFile = path.join(userDir, 'AGENTS.md');
          if (!fs.existsSync(userMemoryFile)) {
            try {
              fs.writeFileSync(userMemoryFile, template, { flag: 'wx' });
              logger.info(
                { userId: user.id },
                'Initialized user-global AGENTS.md from template',
              );
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                logger.warn(
                  { userId: user.id, err },
                  'Failed to initialize user-global AGENTS.md',
                );
              }
            }
          }
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to initialize user-global AGENTS.md files',
        );
      }
    }

    logger.info(
      { groupCount: Object.keys(registeredGroups).length },
      'State loaded',
    );
  };

  const migrateSystemIMToPerUser = (): void => {
    const flagFile = path.join(DATA_DIR, 'config', '.im-config-migrated');
    if (fs.existsSync(flagFile)) return;

    try {
      const adminResult = listUsers({
        status: 'active',
        role: 'admin',
        page: 1,
        pageSize: 1,
      });
      const admin = adminResult.users[0];
      if (!admin) return;

      let migratedFeishu = false;
      let migratedTelegram = false;

      const existingUserFeishu = getUserFeishuConfig(admin.id);
      if (!existingUserFeishu) {
        const { config: sysFeishu, source: feishuSource } =
          getFeishuProviderConfigWithSource();
        if (feishuSource !== 'none' && sysFeishu.appId && sysFeishu.appSecret) {
          saveUserFeishuConfig(admin.id, {
            appId: sysFeishu.appId,
            appSecret: sysFeishu.appSecret,
            enabled: sysFeishu.enabled,
          });
          migratedFeishu = true;
        }
      }

      const existingUserTelegram = getUserTelegramConfig(admin.id);
      if (!existingUserTelegram) {
        const { config: sysTelegram, source: telegramSource } =
          getTelegramProviderConfigWithSource();
        if (telegramSource !== 'none' && sysTelegram.botToken) {
          saveUserTelegramConfig(admin.id, {
            botToken: sysTelegram.botToken,
            proxyUrl: sysTelegram.proxyUrl,
            enabled: sysTelegram.enabled,
          });
          migratedTelegram = true;
        }
      }

      fs.mkdirSync(path.dirname(flagFile), { recursive: true });
      fs.writeFileSync(flagFile, new Date().toISOString() + '\n', 'utf-8');

      if (migratedFeishu || migratedTelegram) {
        logger.info(
          {
            adminId: admin.id,
            feishu: migratedFeishu,
            telegram: migratedTelegram,
          },
          'Migrated system-level IM config to admin per-user config',
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        'Failed to migrate system-level IM config (non-fatal)',
      );
    }
  };

  const movePathWithFallback = (src: string, dst: string): void => {
    try {
      fs.renameSync(src, dst);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        fs.cpSync(src, dst, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
        return;
      }
      throw err;
    }
  };

  const migrateDataDirectories = (): void => {
    const projectRoot = process.cwd();

    const oldStoreDir = path.join(projectRoot, 'store');
    if (fs.existsSync(oldStoreDir)) {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      for (const file of [
        'messages.db',
        'messages.db-wal',
        'messages.db-shm',
      ]) {
        const src = path.join(oldStoreDir, file);
        const dst = path.join(STORE_DIR, file);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          movePathWithFallback(src, dst);
          logger.info({ src, dst }, 'Migrated database file');
        }
      }
      try {
        fs.rmdirSync(oldStoreDir);
      } catch {
        // ignore
      }
    }
  };

  return {
    getAvailableGroups,
    loadState,
    migrateDataDirectories,
    migrateSystemIMToPerUser,
    registerGroup,
    saveState,
    syncGroupMetadata,
  };
}

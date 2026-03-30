import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  isDockerAvailable,
  updateWeChatNoProxy,
} from '../../app/config.js';
import {
  checkAndExpireSubscriptions,
  getUserConcurrentContainerLimit,
  isBillingEnabled,
  reconcileMonthlyUsage,
} from '../billing/billing.js';
import {
  cleanupOldBillingAuditLog,
  cleanupOldDailyUsage,
  closeDatabase,
  deleteCompletedAgents,
  deleteExpiredSessions,
  getAgent,
  getExpiredSessionIds,
  getRegisteredGroup,
  getRuntimeSession,
  getUserById,
  getUserHomeGroup,
  hasContainerModeGroups,
  initDatabase,
  listUsers,
  markAllRunningTaskAgentsAsError,
  markStaleSpawnAgentsAsError,
} from '../../db.js';
import type {
  FeishuConnectConfig,
  QQConnectConfig,
  TelegramConnectConfig,
  WeChatConnectConfig,
} from '../im/im-manager.js';
import { imManager } from '../im/im-manager.js';
import { GROUP_SYNC_INTERVAL_MS } from './bootstrap-state.js';
import {
  IM_HEALTH_CHECK_FAIL_THRESHOLD,
  type ReplyRouteUpdater,
} from './im-routing.js';
import { logger } from '../../app/logger.js';
import {
  getSystemSettings,
  getTelegramProviderConfig,
  getTelegramProviderConfigWithSource,
  getFeishuProviderConfigWithSource,
  getUserFeishuConfig,
  getUserQQConfig,
  getUserTelegramConfig,
  getUserWeChatConfig,
} from '../../runtime-config.js';
import { syncHostSkillsForUser } from '../skills/routes/skills.js';
import { startSchedulerLoop, triggerTaskNow } from '../tasks/task-scheduler.js';
import type {
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
} from '../../shared/types.js';
import { stripVirtualJidSuffix } from '../../shared/im/virtual-jid.js';
import { abortAllStreamingSessions } from '../im/channels/feishu/streaming-card/index.js';
import {
  shutdownTerminals,
  shutdownWebServer,
  startWebServer,
} from '../../web.js';
import { getWebDeps, invalidateSessionCache } from '../../app/web/context.js';
import type { GroupQueue } from './group-queue.js';

const execFileAsync = promisify(execFile);

interface IndexBootstrapDeps {
  activeRouteUpdaters: Map<string, ReplyRouteUpdater>;
  buildIsChatAuthorized: (userId: string) => (jid: string) => boolean;
  buildOnAgentMessage: () => (baseChatJid: string, agentId: string) => void;
  buildOnBotRemovedFromGroup: () => (chatJid: string) => void;
  buildOnNewChat: (
    userId: string,
    homeFolder: string,
  ) => (chatJid: string, chatName: string) => void;
  buildOnPairAttempt: (
    userId: string,
  ) => (jid: string, chatName: string, code: string) => Promise<boolean>;
  buildResolveEffectiveChatJid: () => (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  buildTelegramBotAddedHandler: (
    userId: string,
    homeFolder: string,
  ) => (chatJid: string, chatName: string) => void;
  connectUserIMChannels: (
    userId: string,
    homeFolder: string,
    feishuConfig?: FeishuConnectConfig | null,
    telegramConfig?: TelegramConnectConfig | null,
    qqConfig?: QQConnectConfig | null,
    wechatConfig?: WeChatConnectConfig | null,
    ignoreMessagesBefore?: number,
  ) => Promise<{
    feishu: boolean;
    telegram: boolean;
    qq: boolean;
    wechat: boolean;
  }>;
  ensureTerminalContainerStarted: (chatJid: string) => boolean;
  formatMessages: (...args: any[]) => string;
  getGlobalMessageCursor: () => MessageCursor;
  handleCardInterrupt: (chatJid: string) => void;
  handleCommand: (chatJid: string, command: string) => Promise<string | null>;
  handleSpawnCommand: (
    chatJid: string,
    rawMessage: string,
    sourceImJid?: string,
  ) => Promise<string>;
  imHealthCheckFailCounts: Map<string, number>;
  ipcRuntime: {
    closeAll: () => void;
    startIpcWatcher: () => void;
  };
  isCursorAfter: (cursor: MessageCursor, current: MessageCursor) => boolean;
  lastAgentTimestamp: Record<string, MessageCursor>;
  loadState: () => void;
  migrateDataDirectories: () => void;
  migrateSystemIMToPerUser: () => void;
  processAgentConversation: (chatJid: string, agentId: string) => Promise<void>;
  processGroupMessages: (chatJid: string) => Promise<boolean>;
  queue: GroupQueue;
  recoverConversationAgents: () => void;
  recoverPendingMessages: () => void;
  recoverStreamingBuffer: () => void;
  registeredGroups: Record<string, RegisteredGroup>;
  resolveEffectiveFolder: (chatJid: string) => string;
  resolveEffectiveGroup: (group: RegisteredGroup) => {
    effectiveGroup: RegisteredGroup;
  };
  saveInterruptedStreamingMessages: () => void;
  saveState: () => void;
  sessions: Record<string, RuntimeSessionRecord>;
  setCursors: (jid: string, cursor: MessageCursor) => void;
  setGlobalMessageCursor: (cursor: MessageCursor) => void;
  setShuttingDown: (value: boolean) => void;
  setTyping: (jid: string, isTyping: boolean) => Promise<void>;
  shouldProcessGroupMessage: (chatJid: string) => boolean;
  startMessageLoop: () => void;
  startStreamingBuffer: () => void;
  stopStreamingBuffer: () => void;
  syncGroupMetadata: (force?: boolean) => Promise<void>;
  unbindImGroup: (jid: string, reason: string) => void;
  sendMessage: (...args: any[]) => Promise<string | undefined>;
  sendSystemMessage: (jid: string, type: string, detail: string) => void;
}

export function createBootstrapRuntime(deps: IndexBootstrapDeps): {
  start: () => Promise<void>;
} {
  const {
    activeRouteUpdaters,
    buildIsChatAuthorized,
    buildOnAgentMessage,
    buildOnBotRemovedFromGroup,
    buildOnNewChat,
    buildOnPairAttempt,
    buildResolveEffectiveChatJid,
    buildTelegramBotAddedHandler,
    connectUserIMChannels,
    ensureTerminalContainerStarted,
    formatMessages,
    getGlobalMessageCursor,
    handleCardInterrupt,
    handleCommand,
    handleSpawnCommand,
    imHealthCheckFailCounts,
    ipcRuntime,
    isCursorAfter,
    lastAgentTimestamp,
    loadState,
    migrateDataDirectories,
    migrateSystemIMToPerUser,
    processAgentConversation,
    processGroupMessages,
    queue,
    recoverConversationAgents,
    recoverPendingMessages,
    recoverStreamingBuffer,
    registeredGroups,
    resolveEffectiveFolder,
    resolveEffectiveGroup,
    saveInterruptedStreamingMessages,
    saveState,
    sessions,
    setCursors,
    setGlobalMessageCursor,
    setShuttingDown,
    setTyping,
    shouldProcessGroupMessage,
    startMessageLoop,
    startStreamingBuffer,
    stopStreamingBuffer,
    syncGroupMetadata,
    unbindImGroup,
    sendMessage,
    sendSystemMessage,
  } = deps;

  let feishuSyncInterval: ReturnType<typeof setInterval> | null = null;
  let shutdownInProgress = false;

  async function ensureDockerRunning(): Promise<void> {
    if (!hasContainerModeGroups()) {
      logger.info('All groups use host execution mode, skipping Docker checks');
      return;
    }

    if (!(await isDockerAvailable())) {
      logger.warn(
        'Docker is not available — container-mode workspaces will fail at message time. ' +
          'Start Docker if you need container execution (macOS: Docker Desktop, Linux: sudo systemctl start docker).',
      );
      return;
    }
    logger.debug('Docker daemon is running');

    try {
      const { stdout: psOut } = await execFileAsync(
        'pgrep',
        ['-f', 'node.*container/agent-runner/dist/index\\.js'],
        { timeout: 5000 },
      );
      const pids = (typeof psOut === 'string' ? psOut : String(psOut))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(Number)
        .filter((pid) => pid !== process.pid && !isNaN(pid));
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
      if (pids.length > 0) {
        logger.info(
          { count: pids.length, pids },
          'Killed orphaned host agent-runner processes',
        );
      }
    } catch (err: any) {
      if (err?.code !== 1) {
        logger.warn({ err }, 'Failed to clean up orphaned host processes');
      }
    }

    try {
      const orphanSet = new Set<string>();
      for (const prefix of ['happypaw-']) {
        const { stdout } = await execFileAsync(
          'docker',
          ['ps', '--filter', `name=${prefix}`, '--format', '{{.Names}}'],
          { timeout: 10000 },
        );
        const output = typeof stdout === 'string' ? stdout : String(stdout);
        for (const name of output.trim().split('\n').filter(Boolean)) {
          orphanSet.add(name);
        }
      }
      const orphans = [...orphanSet];
      for (const name of orphans) {
        try {
          await execFileAsync('docker', ['stop', name], { timeout: 10000 });
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned containers');
    }
  }

  async function checkImBindingsHealth(): Promise<void> {
    const boundEntries: Array<{ jid: string; group: RegisteredGroup }> = [];
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (group.target_agent_id || group.target_main_jid) {
        boundEntries.push({ jid, group });
      }
    }

    if (boundEntries.length === 0) return;
    logger.debug(
      { count: boundEntries.length },
      'Running IM binding health check',
    );

    for (const { jid, group } of boundEntries) {
      if (group.target_main_jid) {
        const targetGroup =
          registeredGroups[group.target_main_jid] ??
          getRegisteredGroup(group.target_main_jid);
        if (!targetGroup) {
          unbindImGroup(
            jid,
            `Orphaned main conversation binding: target ${group.target_main_jid} no longer exists`,
          );
          continue;
        }
      }

      if (group.target_agent_id) {
        const agent = getAgent(group.target_agent_id);
        if (!agent) {
          unbindImGroup(
            jid,
            `Orphaned agent binding: agent ${group.target_agent_id} no longer exists`,
          );
          continue;
        }
      }

      try {
        const info = await imManager.getChatInfo(jid);
        if (info === undefined) continue;
        if (info === null) {
          const count = (imHealthCheckFailCounts.get(jid) ?? 0) + 1;
          imHealthCheckFailCounts.set(jid, count);
          if (count >= IM_HEALTH_CHECK_FAIL_THRESHOLD) {
            unbindImGroup(
              jid,
              'IM group not reachable after multiple checks, auto-unbinding',
            );
          } else {
            logger.debug(
              {
                jid,
                failCount: count,
                threshold: IM_HEALTH_CHECK_FAIL_THRESHOLD,
              },
              'IM health check failed, will retry before unbinding',
            );
          }
        } else {
          imHealthCheckFailCounts.delete(jid);
        }
      } catch (err) {
        logger.debug({ jid, err }, 'IM binding health check failed for group');
      }
    }
  }

  async function shutdown(signal: string): Promise<void> {
    if (shutdownInProgress) {
      logger.warn('Force exit (second signal)');
      process.exit(1);
    }
    shutdownInProgress = true;
    setShuttingDown(true);
    logger.info({ signal }, 'Shutdown signal received, cleaning up...');

    const forceExitTimer = setTimeout(() => {
      logger.warn('Graceful shutdown timed out, force exiting');
      process.exit(1);
    }, 2000);
    forceExitTimer.unref();

    if (feishuSyncInterval) {
      clearInterval(feishuSyncInterval);
      feishuSyncInterval = null;
    }

    try {
      ipcRuntime.closeAll();
    } catch (err) {
      logger.warn({ err }, 'Error closing IPC watchers');
    }

    try {
      shutdownTerminals();
    } catch (err) {
      logger.warn({ err }, 'Error shutting down terminals');
    }

    stopStreamingBuffer();
    saveInterruptedStreamingMessages();

    await Promise.allSettled([
      abortAllStreamingSessions('服务维护中').catch((err) =>
        logger.warn({ err }, 'Error aborting streaming sessions'),
      ),
      imManager
        .disconnectAll()
        .catch((err) =>
          logger.warn({ err }, 'Error disconnecting IM connections'),
        ),
      shutdownWebServer().catch((err) =>
        logger.warn({ err }, 'Error shutting down web server'),
      ),
      queue
        .shutdown(1500)
        .catch((err) => logger.warn({ err }, 'Error shutting down queue')),
    ]);

    try {
      closeDatabase();
    } catch (err) {
      logger.warn({ err }, 'Error closing database');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  }

  async function start(): Promise<void> {
    migrateDataDirectories();
    initDatabase();
    logger.info('Database initialized');

    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const cleaned = deleteCompletedAgents(oneHourAgo);
      if (cleaned > 0) {
        logger.info({ cleaned }, 'Cleaned up stale completed agents');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up stale task agents');
    }

    try {
      const marked = markAllRunningTaskAgentsAsError();
      if (marked > 0) {
        logger.warn(
          { marked },
          'Marked stale running task agents as error at startup',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to mark stale running tasks at startup');
    }

    try {
      const marked = markStaleSpawnAgentsAsError();
      if (marked > 0) {
        logger.warn(
          { marked },
          'Marked stale spawn agents as error at startup',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to mark stale spawn agents at startup');
    }

    updateWeChatNoProxy(true);
    migrateSystemIMToPerUser();
    loadState();

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    const reloadFeishuConnection = async (config: {
      appId: string;
      appSecret: string;
      enabled?: boolean;
    }): Promise<boolean> => {
      const adminUser = listUsers({
        status: 'active',
        role: 'admin',
        page: 1,
        pageSize: 1,
      }).users[0];
      if (!adminUser) {
        logger.warn('No admin user found for Feishu reload');
        return false;
      }

      await imManager.disconnectUserFeishu(adminUser.id);
      if (feishuSyncInterval) {
        clearInterval(feishuSyncInterval);
        feishuSyncInterval = null;
      }

      if (config.enabled !== false && config.appId && config.appSecret) {
        const homeGroup = getUserHomeGroup(adminUser.id);
        const homeFolder = homeGroup?.folder || MAIN_GROUP_FOLDER;
        const onNewChat = buildOnNewChat(adminUser.id, homeFolder);
        const connected = await imManager.connectUserFeishu(
          adminUser.id,
          config,
          onNewChat,
          {
            ignoreMessagesBefore: Date.now(),
            onCommand: handleCommand,
            onBotAddedToGroup: buildOnNewChat(adminUser.id, homeFolder),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            shouldProcessGroupMessage,
            onCardInterrupt: handleCardInterrupt,
          },
        );
        if (connected) {
          syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Group sync after Feishu reconnect failed'),
          );
          feishuSyncInterval = setInterval(() => {
            syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }
        return connected;
      }

      logger.info('Feishu channel disabled via hot-reload');
      return false;
    };

    const reloadTelegramConnection = async (config: {
      botToken: string;
      proxyUrl?: string;
      enabled?: boolean;
    }): Promise<boolean> => {
      const adminUser = listUsers({
        status: 'active',
        role: 'admin',
        page: 1,
        pageSize: 1,
      }).users[0];
      if (!adminUser) {
        logger.warn('No admin user found for Telegram reload');
        return false;
      }

      await imManager.disconnectUserTelegram(adminUser.id);

      if (config.enabled !== false && config.botToken) {
        const homeGroup = getUserHomeGroup(adminUser.id);
        const homeFolder = homeGroup?.folder || MAIN_GROUP_FOLDER;
        const onNewChat = buildOnNewChat(adminUser.id, homeFolder);
        return imManager.connectUserTelegram(
          adminUser.id,
          config,
          onNewChat,
          buildIsChatAuthorized(adminUser.id),
          buildOnPairAttempt(adminUser.id),
          {
            onCommand: handleCommand,
            ignoreMessagesBefore: Date.now(),
            resolveGroupFolder: (chatJid) => resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onBotAddedToGroup: buildTelegramBotAddedHandler(
              adminUser.id,
              homeFolder,
            ),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
          },
        );
      }

      logger.info('Telegram channel disabled via hot-reload');
      return false;
    };

    const reloadUserIMConfig = async (
      userId: string,
      channel: 'feishu' | 'telegram' | 'qq' | 'wechat',
    ): Promise<boolean> => {
      const homeGroup = getUserHomeGroup(userId);
      if (!homeGroup) {
        logger.warn(
          { userId, channel },
          'No home group found for user IM reload',
        );
        return false;
      }

      const homeFolder = homeGroup.folder;
      const onNewChat = buildOnNewChat(userId, homeFolder);
      const ignoreMessagesBefore = Date.now();

      if (channel === 'feishu') {
        await imManager.disconnectUserFeishu(userId);
        const config = getUserFeishuConfig(userId);
        if (
          config &&
          config.enabled !== false &&
          config.appId &&
          config.appSecret
        ) {
          const connected = await imManager.connectUserFeishu(
            userId,
            config,
            onNewChat,
            {
              ignoreMessagesBefore,
              onCommand: handleCommand,
              onBotAddedToGroup: buildOnNewChat(userId, homeFolder),
              onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
              shouldProcessGroupMessage,
              onCardInterrupt: handleCardInterrupt,
            },
          );
          logger.info(
            { userId, connected },
            'User Feishu connection hot-reloaded',
          );
          return connected;
        }
        logger.info({ userId }, 'User Feishu channel disabled via hot-reload');
        return false;
      }

      if (channel === 'telegram') {
        await imManager.disconnectUserTelegram(userId);
        const config = getUserTelegramConfig(userId);
        const globalTelegramConfig = getTelegramProviderConfig();
        if (config && config.enabled !== false && config.botToken) {
          const connected = await imManager.connectUserTelegram(
            userId,
            {
              ...config,
              proxyUrl: config.proxyUrl || globalTelegramConfig.proxyUrl,
            },
            onNewChat,
            buildIsChatAuthorized(userId),
            buildOnPairAttempt(userId),
            {
              onCommand: handleCommand,
              ignoreMessagesBefore,
              resolveGroupFolder: (chatJid) => resolveEffectiveFolder(chatJid),
              resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
              onAgentMessage: buildOnAgentMessage(),
              onBotAddedToGroup: buildTelegramBotAddedHandler(
                userId,
                homeFolder,
              ),
              onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            },
          );
          logger.info(
            { userId, connected },
            'User Telegram connection hot-reloaded',
          );
          return connected;
        }
        logger.info(
          { userId },
          'User Telegram channel disabled via hot-reload',
        );
        return false;
      }

      if (channel === 'qq') {
        await imManager.disconnectUserQQ(userId);
        const config = getUserQQConfig(userId);
        if (
          config &&
          config.enabled !== false &&
          config.appId &&
          config.appSecret
        ) {
          const connected = await imManager.connectUserQQ(
            userId,
            config,
            onNewChat,
            buildIsChatAuthorized(userId),
            buildOnPairAttempt(userId),
            {
              onCommand: handleCommand,
              resolveGroupFolder: (chatJid) => resolveEffectiveFolder(chatJid),
              resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
              onAgentMessage: buildOnAgentMessage(),
            },
          );
          logger.info({ userId, connected }, 'User QQ connection hot-reloaded');
          return connected;
        }
        logger.info({ userId }, 'User QQ channel disabled via hot-reload');
        return false;
      }

      await imManager.disconnectUserWeChat(userId);
      const config = getUserWeChatConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.botToken &&
        config.ilinkBotId
      ) {
        const connected = await imManager.connectUserWeChat(
          userId,
          {
            botToken: config.botToken,
            ilinkBotId: config.ilinkBotId,
            baseUrl: config.baseUrl,
            cdnBaseUrl: config.cdnBaseUrl,
            getUpdatesBuf: config.getUpdatesBuf,
          },
          onNewChat,
          {
            ignoreMessagesBefore: Date.now(),
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid) => resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
          },
        );
        logger.info(
          { userId, connected },
          'User WeChat connection hot-reloaded',
        );
        return connected;
      }

      logger.info({ userId }, 'User WeChat channel disabled via hot-reload');
      return false;
    };

    startWebServer({
      queue,
      getRegisteredGroups: () => registeredGroups,
      getSessions: () => sessions,
      getRuntimeSession,
      processGroupMessages,
      ensureTerminalContainerStarted,
      formatMessages,
      getLastAgentTimestamp: () => lastAgentTimestamp,
      setLastAgentTimestamp: setCursors,
      advanceGlobalCursor: (cursor: MessageCursor) => {
        const globalMessageCursor = getGlobalMessageCursor();
        if (isCursorAfter(cursor, globalMessageCursor)) {
          setGlobalMessageCursor(cursor);
          saveState();
        }
      },
      reloadFeishuConnection,
      reloadTelegramConnection,
      reloadUserIMConfig,
      isFeishuConnected: () => imManager.isAnyFeishuConnected(),
      isTelegramConnected: () => imManager.isAnyTelegramConnected(),
      isUserFeishuConnected: (userId: string) =>
        imManager.isFeishuConnected(userId),
      isUserTelegramConnected: (userId: string) =>
        imManager.isTelegramConnected(userId),
      isUserQQConnected: (userId: string) => imManager.isQQConnected(userId),
      isUserWeChatConnected: (userId: string) =>
        imManager.isWeChatConnected(userId),
      processAgentConversation,
      getFeishuChatInfo: (userId: string, chatId: string) =>
        imManager.getFeishuChatInfo(userId, chatId),
      clearImFailCounts: (jid: string) => {
        imHealthCheckFailCounts.delete(jid);
      },
      updateReplyRoute: (folder: string, sourceJid: string | null) => {
        activeRouteUpdaters.get(folder)?.(sourceJid);
      },
      handleSpawnCommand,
    });

    setInterval(
      () => {
        try {
          const expiredIds = getExpiredSessionIds();
          for (const id of expiredIds) invalidateSessionCache(id);
          const deleted = deleteExpiredSessions();
          if (deleted > 0) {
            logger.info({ deleted }, 'Cleaned expired user sessions');
          }
        } catch (err) {
          logger.error({ err }, 'Failed to clean expired sessions');
        }
      },
      60 * 60 * 1000,
    );

    setInterval(
      () => {
        try {
          const tenMinutesAgo = new Date(
            Date.now() - 10 * 60 * 1000,
          ).toISOString();
          const cleaned = deleteCompletedAgents(tenMinutesAgo);
          if (cleaned > 0) {
            logger.info(
              { cleaned },
              'Periodic cleanup: removed completed agents',
            );
          }
        } catch (err) {
          logger.warn({ err }, 'Failed periodic task agent cleanup');
        }
      },
      10 * 60 * 1000,
    );

    setInterval(
      () => {
        checkAndExpireSubscriptions();
      },
      60 * 60 * 1000,
    );

    setInterval(
      () => {
        if (!isBillingEnabled()) return;
        try {
          const month = new Date().toISOString().slice(0, 7);
          let page = 1;
          const pageSize = 200;
          while (true) {
            const batch = listUsers({ status: 'active', pageSize, page });
            for (const user of batch.users) {
              if (user.role === 'admin') continue;
              reconcileMonthlyUsage(user.id, month);
            }
            if (batch.users.length < pageSize) break;
            page++;
          }
        } catch (err) {
          logger.error({ err }, 'Failed to run monthly usage reconciliation');
        }
      },
      6 * 60 * 60 * 1000,
    );

    setInterval(
      () => {
        try {
          const deletedDaily = cleanupOldDailyUsage();
          const deletedAudit = cleanupOldBillingAuditLog();
          if (deletedDaily > 0 || deletedAudit > 0) {
            logger.info(
              { deletedDaily, deletedAudit },
              'Cleaned up old billing data',
            );
          }
        } catch (err) {
          logger.error({ err }, 'Failed to cleanup old billing data');
        }
      },
      24 * 60 * 60 * 1000,
    );

    let skillAutoSyncTimer: ReturnType<typeof setInterval> | null = null;

    function stopSkillAutoSync(): void {
      if (skillAutoSyncTimer) {
        clearInterval(skillAutoSyncTimer);
        skillAutoSyncTimer = null;
      }
    }

    function startSkillAutoSync(): void {
      stopSkillAutoSync();
      const settings = getSystemSettings();
      if (!settings.skillAutoSyncEnabled) return;

      const intervalMs = settings.skillAutoSyncIntervalMinutes * 60 * 1000;
      logger.info(
        { intervalMinutes: settings.skillAutoSyncIntervalMinutes },
        'Starting skill auto-sync timer',
      );

      const runSync = async () => {
        const currentSettings = getSystemSettings();
        if (!currentSettings.skillAutoSyncEnabled) {
          stopSkillAutoSync();
          return;
        }

        try {
          const { users: adminUsers } = listUsers({
            role: 'admin',
            status: 'active',
          });
          for (const admin of adminUsers) {
            try {
              const result = await syncHostSkillsForUser(admin.id);
              const { added, updated, deleted } = result.stats;
              if (added > 0 || updated > 0 || deleted > 0) {
                logger.info(
                  {
                    userId: admin.id,
                    username: admin.username,
                    ...result.stats,
                    total: result.total,
                  },
                  'Skill auto-sync completed with changes',
                );
              }
            } catch (err) {
              logger.warn(
                { err, userId: admin.id },
                'Skill auto-sync failed for user',
              );
            }
          }
        } catch (err) {
          logger.error({ err }, 'Skill auto-sync failed');
        }
      };

      void runSync();
      skillAutoSyncTimer = setInterval(() => void runSync(), intervalMs);
    }

    const initSettings = getSystemSettings();
    let lastSkillSyncEnabled = initSettings.skillAutoSyncEnabled;
    let lastSkillSyncInterval = initSettings.skillAutoSyncIntervalMinutes;
    startSkillAutoSync();

    setInterval(() => {
      const settings = getSystemSettings();
      if (
        settings.skillAutoSyncEnabled !== lastSkillSyncEnabled ||
        settings.skillAutoSyncIntervalMinutes !== lastSkillSyncInterval
      ) {
        lastSkillSyncEnabled = settings.skillAutoSyncEnabled;
        lastSkillSyncInterval = settings.skillAutoSyncIntervalMinutes;
        startSkillAutoSync();
      }
    }, 60 * 1000);

    await ensureDockerRunning();

    queue.setProcessMessagesFn(processGroupMessages);
    queue.setHostModeChecker((groupJid: string) => {
      const baseJid = stripVirtualJidSuffix(groupJid);

      let group = registeredGroups[baseJid];
      if (!group) {
        const dbGroup = getRegisteredGroup(baseJid);
        if (dbGroup) {
          registeredGroups[baseJid] = dbGroup;
          group = dbGroup;
        }
      }
      if (!group) return false;

      const { effectiveGroup } = resolveEffectiveGroup(group);
      return effectiveGroup.executionMode === 'host';
    });
    queue.setSerializationKeyResolver((groupJid: string) => {
      const agentSep = groupJid.indexOf('#agent:');
      if (agentSep >= 0) {
        const baseJid = groupJid.slice(0, agentSep);
        const agentId = groupJid.slice(agentSep + 7);
        const group = registeredGroups[baseJid];
        const folder = group?.folder || baseJid;
        return `${folder}#${agentId}`;
      }

      const taskSep = groupJid.indexOf('#task:');
      if (taskSep >= 0) {
        const baseJid = groupJid.slice(0, taskSep);
        const taskId = groupJid.slice(taskSep + 6);
        const group = registeredGroups[baseJid];
        return `${group?.folder || baseJid}#task:${taskId}`;
      }

      const group = registeredGroups[groupJid];
      return group?.folder || groupJid;
    });
    queue.setOnMaxRetriesExceeded((groupJid: string) => {
      const group = registeredGroups[groupJid];
      const name = group?.name || groupJid;
      sendSystemMessage(
        groupJid,
        'agent_max_retries',
        `${name} 处理失败，已达最大重试次数`,
      );
      void setTyping(groupJid, false);
    });
    queue.setUserConcurrentLimitChecker((groupJid: string) => {
      if (!isBillingEnabled()) return { allowed: true };
      const baseJid = stripVirtualJidSuffix(groupJid);
      const group = registeredGroups[baseJid];
      if (!group?.created_by) return { allowed: true };
      const owner = getUserById(group.created_by);
      if (!owner || owner.role === 'admin') return { allowed: true };
      const limit = getUserConcurrentContainerLimit(owner.id, owner.role);
      if (limit == null) return { allowed: true };
      let userActive = 0;
      for (const [jid, registeredGroup] of Object.entries(registeredGroups)) {
        if (
          registeredGroup.created_by === owner.id &&
          queue.hasDirectActiveRunner(jid)
        ) {
          userActive++;
        }
      }
      return { allowed: userActive < limit };
    });
    queue.setOnUnconsumedAgentIpc((groupJid: string, agentId: string) => {
      const baseChatJid = groupJid.includes('#agent:')
        ? groupJid.split('#agent:')[0]
        : groupJid;
      const agent = getAgent(agentId);
      const homeChatJid = agent?.chat_jid || baseChatJid;
      const virtualChatJid = `${homeChatJid}#agent:${agentId}`;
      const taskId = `agent-ipc-recovery:${agentId}:${Date.now()}`;
      queue.enqueueTask(virtualChatJid, taskId, async () => {
        await processAgentConversation(homeChatJid, agentId);
      });
    });

    const schedulerDeps: import('../tasks/task-scheduler.js').SchedulerDependencies =
      {
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions,
        queue,
        onProcess: (
          groupJid,
          proc,
          containerName,
          groupFolder,
          displayName,
          taskRunId,
        ) =>
          queue.registerProcess(
            groupJid,
            proc,
            containerName,
            groupFolder,
            displayName,
            undefined,
            taskRunId,
          ),
        sendMessage,
        assistantName: ASSISTANT_NAME,
        dailySummaryDeps: {
          logger,
          dataDir: DATA_DIR,
        },
      };
    startSchedulerLoop(schedulerDeps);

    const webDeps = getWebDeps();
    if (webDeps) {
      webDeps.triggerTaskRun = (taskId: string) =>
        triggerTaskNow(taskId, schedulerDeps);
    }

    ipcRuntime.startIpcWatcher();
    recoverStreamingBuffer();
    recoverPendingMessages();
    recoverConversationAgents();
    startStreamingBuffer();
    startMessageLoop();

    const globalFeishuConfig = getFeishuProviderConfigWithSource();
    const globalTelegramConfig = getTelegramProviderConfigWithSource();

    let allActiveUsers: ReturnType<typeof listUsers>['users'] = [];
    let page = 1;
    while (true) {
      const result = listUsers({ status: 'active', page, pageSize: 200 });
      allActiveUsers = allActiveUsers.concat(result.users);
      if (allActiveUsers.length >= result.total) break;
      page++;
    }

    let anyFeishuConnected = false;

    for (const user of allActiveUsers) {
      const homeGroup = getUserHomeGroup(user.id);
      if (!homeGroup) continue;

      const userFeishu = getUserFeishuConfig(user.id);
      const userTelegram = getUserTelegramConfig(user.id);
      const userQQ = getUserQQConfig(user.id);
      const userWeChat = getUserWeChatConfig(user.id);

      let effectiveFeishu: FeishuConnectConfig | null = null;
      if (userFeishu && userFeishu.appId && userFeishu.appSecret) {
        effectiveFeishu = {
          appId: userFeishu.appId,
          appSecret: userFeishu.appSecret,
          enabled: userFeishu.enabled,
        };
      } else if (
        user.role === 'admin' &&
        globalFeishuConfig.source !== 'none'
      ) {
        const config = globalFeishuConfig.config;
        effectiveFeishu = {
          appId: config.appId,
          appSecret: config.appSecret,
          enabled: config.enabled,
        };
      }

      let effectiveTelegram: TelegramConnectConfig | null = null;
      if (userTelegram && userTelegram.botToken) {
        effectiveTelegram = {
          botToken: userTelegram.botToken,
          proxyUrl:
            userTelegram.proxyUrl || globalTelegramConfig.config.proxyUrl,
          enabled: userTelegram.enabled,
        };
      } else if (
        user.role === 'admin' &&
        globalTelegramConfig.source !== 'none'
      ) {
        const config = globalTelegramConfig.config;
        effectiveTelegram = {
          botToken: config.botToken,
          proxyUrl: config.proxyUrl,
          enabled: config.enabled,
        };
      }

      let effectiveQQ: QQConnectConfig | null = null;
      if (userQQ && userQQ.appId && userQQ.appSecret) {
        effectiveQQ = {
          appId: userQQ.appId,
          appSecret: userQQ.appSecret,
          enabled: userQQ.enabled,
        };
      }

      let effectiveWeChat: WeChatConnectConfig | null = null;
      if (userWeChat && userWeChat.botToken && userWeChat.ilinkBotId) {
        effectiveWeChat = {
          botToken: userWeChat.botToken,
          ilinkBotId: userWeChat.ilinkBotId,
          baseUrl: userWeChat.baseUrl,
          cdnBaseUrl: userWeChat.cdnBaseUrl,
          getUpdatesBuf: userWeChat.getUpdatesBuf,
          enabled: userWeChat.enabled,
        };
      }

      if (
        !effectiveFeishu &&
        !effectiveTelegram &&
        !effectiveQQ &&
        !effectiveWeChat
      ) {
        continue;
      }

      try {
        const result = await connectUserIMChannels(
          user.id,
          homeGroup.folder,
          effectiveFeishu,
          effectiveTelegram,
          effectiveQQ,
          effectiveWeChat,
          Date.now(),
        );
        if (result.feishu) anyFeishuConnected = true;
        logger.info(
          {
            userId: user.id,
            feishu: result.feishu,
            telegram: result.telegram,
            qq: result.qq,
            wechat: result.wechat,
          },
          'User IM channels connected',
        );
      } catch (err) {
        logger.error(
          { userId: user.id, err },
          'Failed to connect user IM channels',
        );
      }
    }

    if (anyFeishuConnected) {
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Initial group sync failed'),
      );
      feishuSyncInterval = setInterval(() => {
        syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Periodic group sync failed'),
        );
      }, GROUP_SYNC_INTERVAL_MS);
    } else if (
      globalFeishuConfig.config.enabled !== false &&
      globalFeishuConfig.source !== 'none'
    ) {
      logger.warn(
        'Feishu is not connected. Configure credentials in Settings to enable Feishu sync.',
      );
    }

    void checkImBindingsHealth();
    setInterval(
      () => {
        void checkImBindingsHealth();
      },
      30 * 60 * 1000,
    );
  }

  return { start };
}

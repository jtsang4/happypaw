import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../app/config.js';
import {
  getAgent,
  getJidsByFolder,
  getMessagesSince,
  getRegisteredGroup,
  getUserHomeGroup,
  setRegisteredGroup,
} from '../../db.js';
import { getChannelType } from '../im/im-channel.js';
import type {
  FeishuConnectConfig,
  QQConnectConfig,
  TelegramConnectConfig,
  WeChatConnectConfig,
} from '../im/im-manager.js';
import { imManager } from '../im/im-manager.js';
import { logger } from '../../app/logger.js';
import type { GroupQueue } from './group-queue.js';
import type { MessageCursor, RegisteredGroup } from '../../shared/types.js';
import { getStreamingSession } from '../im/channels/feishu/streaming-card/index.js';
import type { ConnectFeishuOptions } from '../im/im-manager.js';
import { verifyPairingCode } from '../im/channels/telegram/pairing.js';
import {
  getActiveImReplyRouteSnapshotPath as getFolderImReplyRouteSnapshotPath,
  persistActiveImReplyRouteSnapshot,
} from './im-reply-route-snapshot.js';

const RELATIVE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
]);

const IM_SEND_MAX_RETRIES = 3;
const IM_SEND_RETRY_DELAY_MS = 2_000;
const IM_SEND_FAIL_THRESHOLD = 3;
const IM_HEALTH_CHECK_FAIL_THRESHOLD = 3;
export type ReplyRouteUpdater = (newSourceJid: string | null) => void;

export function resolveReplyRouteJid(
  activeImReplyRoutes: Map<string, string | null>,
  folder: string,
  chatJid: string,
  agentId?: string,
  isChannelAvailableForJid: (jid: string) => boolean = (jid) =>
    imManager.isChannelAvailableForJid(jid),
): string | undefined {
  if (agentId) {
    const agent = getAgent(agentId);
    if (agent?.last_im_jid && isChannelAvailableForJid(agent.last_im_jid)) {
      return agent.last_im_jid;
    }
  }

  const activeRoute = activeImReplyRoutes.get(folder) || undefined;
  if (activeRoute) return activeRoute;
  if (!agentId && getChannelType(chatJid) !== null) return chatJid;
  return undefined;
}

export function getActiveImReplyRouteSnapshotPath(folder: string): string {
  return getFolderImReplyRouteSnapshotPath(folder);
}

export function persistActiveImReplyRoute(
  folder: string,
  replyJid: string | null,
): void {
  persistActiveImReplyRouteSnapshot(
    getActiveImReplyRouteSnapshotPath(folder),
    replyJid,
  );
}

export function createImRoutingHelpers(deps: {
  queue: GroupQueue;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: Record<string, RegisteredGroup>;
  imSendFailCounts: Map<string, number>;
  imHealthCheckFailCounts: Map<string, number>;
  lastAgentTimestamp: Record<string, MessageCursor>;
  activeImReplyRoutes: Map<string, string | null>;
  activeRouteUpdaters: Map<string, ReplyRouteUpdater>;
  handleCommand: (chatJid: string, command: string) => Promise<string | null>;
  processAgentConversation: (chatJid: string, agentId: string) => Promise<void>;
  formatMessages: (messages: any[], isShared?: boolean) => string;
  collectMessageImages: (
    chatJid: string,
    messages: any[],
  ) => Array<{ data: string; mimeType: string }>;
  emptyCursor: MessageCursor;
}): {
  unbindImGroup: (jid: string, reason: string) => void;
  resolveEffectiveFolder: (chatJid: string) => string | undefined;
  resolveEffectiveGroup: (group: RegisteredGroup) => {
    effectiveGroup: RegisteredGroup;
    isHome: boolean;
  };
  resolveOwnerHomeFolder: (group: RegisteredGroup) => string;
  extractLocalImImagePaths: (text: string, groupFolder?: string) => string[];
  retryImOperation: (
    label: string,
    imJid: string,
    fn: () => Promise<void>,
  ) => Promise<boolean>;
  sendImWithRetry: (
    imJid: string,
    text: string,
    localImagePaths: string[],
  ) => Promise<boolean>;
  sendImWithFailTracking: (
    imJid: string,
    text: string,
    localImagePaths: string[],
  ) => void;
  setActiveImReplyRoute: (folder: string, replyJid: string | null) => void;
  clearActiveImReplyRoute: (folder: string) => void;
  buildOnNewChat: (
    userId: string,
    homeFolder: string,
  ) => (chatJid: string, chatName: string) => void;
  buildOnBotRemovedFromGroup: () => (chatJid: string) => void;
  buildTelegramBotAddedHandler: (
    userId: string,
    homeFolder: string,
  ) => (chatJid: string, chatName: string) => void;
  buildIsChatAuthorized: (userId: string) => (jid: string) => boolean;
  buildOnPairAttempt: (
    userId: string,
  ) => (jid: string, chatName: string, code: string) => Promise<boolean>;
  buildResolveEffectiveChatJid: () => (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  buildOnAgentMessage: () => (baseChatJid: string, agentId: string) => void;
  shouldProcessGroupMessage: (chatJid: string) => boolean;
  handleCardInterrupt: (chatJid: string) => void;
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
} {
  function setActiveImReplyRoute(
    folder: string,
    replyJid: string | null,
  ): void {
    deps.activeImReplyRoutes.set(folder, replyJid);
    persistActiveImReplyRoute(folder, replyJid);
  }

  function clearActiveImReplyRoute(folder: string): void {
    deps.activeImReplyRoutes.delete(folder);
    persistActiveImReplyRoute(folder, null);
  }

  function unbindImGroup(jid: string, reason: string): void {
    const group = deps.registeredGroups[jid] ?? getRegisteredGroup(jid);
    if (!group?.target_agent_id && !group?.target_main_jid) return;
    const agentId = group.target_agent_id;
    const targetMainJid = group.target_main_jid;
    const updated = {
      ...group,
      target_agent_id: undefined,
      target_main_jid: undefined,
      reply_policy: 'source_only' as const,
    };
    setRegisteredGroup(jid, updated);
    deps.registeredGroups[jid] = updated;
    deps.imSendFailCounts.delete(jid);
    deps.imHealthCheckFailCounts.delete(jid);
    logger.info({ jid, agentId, targetMainJid }, reason);
  }

  function resolveEffectiveFolder(chatJid: string): string | undefined {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return undefined;

    if (group.target_agent_id) {
      const agent = getAgent(group.target_agent_id);
      const agentParent = agent
        ? (deps.registeredGroups[agent.chat_jid] ??
          getRegisteredGroup(agent.chat_jid))
        : null;
      return agentParent?.folder || group.folder;
    }

    if (group.target_main_jid) {
      const targetGroup =
        deps.registeredGroups[group.target_main_jid] ??
        getRegisteredGroup(group.target_main_jid);
      return targetGroup?.folder || group.target_main_jid.replace(/^web:/, '');
    }

    return group.folder;
  }

  function resolveEffectiveGroup(group: RegisteredGroup): {
    effectiveGroup: RegisteredGroup;
    isHome: boolean;
  } {
    if (group.is_home) return { effectiveGroup: group, isHome: true };

    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      const sibling = deps.registeredGroups[jid] ?? getRegisteredGroup(jid);
      if (sibling && !deps.registeredGroups[jid])
        deps.registeredGroups[jid] = sibling;
      if (sibling?.is_home) {
        return {
          effectiveGroup: {
            ...group,
            executionMode: sibling.executionMode,
            customCwd: sibling.customCwd || group.customCwd,
            created_by: group.created_by || sibling.created_by,
            is_home: true,
          },
          isHome: true,
        };
      }
    }

    return { effectiveGroup: group, isHome: false };
  }

  function resolveOwnerHomeFolder(group: RegisteredGroup): string {
    if (group.created_by) {
      return getUserHomeGroup(group.created_by)?.folder || group.folder;
    }
    return group.folder;
  }

  function extractLocalImImagePaths(
    text: string,
    groupFolder?: string,
  ): string[] {
    if (!groupFolder || !text) return [];

    const workspaceRoot = path.resolve(GROUPS_DIR, groupFolder);
    const seen = new Set<string>();
    const imagePaths: string[] = [];
    const candidates: string[] = [];
    const markdownImageRe = /!\[[^\]]*]\(([^)]+)\)/g;
    const taggedImageRe = /\[图片:\s*([^\]\n]+)\]/g;

    const pushCandidate = (raw: string): void => {
      const trimmed = raw.trim().replace(/^<|>$/g, '');
      const pathToken = trimmed
        .split(/\s+/)[0]
        ?.trim()
        .replace(/^['"]|['"]$/g, '');
      if (
        !pathToken ||
        pathToken.startsWith('/') ||
        pathToken.startsWith('data:') ||
        /^[a-z]+:\/\//i.test(pathToken)
      ) {
        return;
      }
      candidates.push(pathToken);
    };

    for (const match of text.matchAll(markdownImageRe)) {
      pushCandidate(match[1] || '');
    }
    for (const match of text.matchAll(taggedImageRe)) {
      pushCandidate(match[1] || '');
    }

    for (const candidate of candidates) {
      const resolved = path.resolve(workspaceRoot, candidate);
      const ext = path.extname(resolved).toLowerCase();
      if (!RELATIVE_IMAGE_EXTENSIONS.has(ext)) continue;
      if (
        resolved !== workspaceRoot &&
        !resolved.startsWith(workspaceRoot + path.sep)
      ) {
        continue;
      }
      if (seen.has(resolved)) continue;
      try {
        if (!fs.statSync(resolved).isFile()) continue;
        seen.add(resolved);
        imagePaths.push(resolved);
      } catch {
        continue;
      }
    }

    return imagePaths;
  }

  async function retryImOperation(
    label: string,
    imJid: string,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < IM_SEND_MAX_RETRIES; attempt++) {
      try {
        await fn();
        return true;
      } catch (err) {
        logger.warn(
          { imJid, attempt, label, err },
          'IM operation attempt failed',
        );
        if (attempt < IM_SEND_MAX_RETRIES - 1) {
          await new Promise((r) =>
            setTimeout(r, IM_SEND_RETRY_DELAY_MS * (attempt + 1)),
          );
        }
      }
    }
    logger.error({ imJid, label }, 'IM operation failed after all retries');
    return false;
  }

  async function sendImWithRetry(
    imJid: string,
    text: string,
    localImagePaths: string[],
  ): Promise<boolean> {
    const ok = await retryImOperation('send_message', imJid, () =>
      imManager.sendMessage(imJid, text, localImagePaths),
    );
    if (ok) {
      deps.imSendFailCounts.delete(imJid);
      return true;
    }
    const count = (deps.imSendFailCounts.get(imJid) ?? 0) + 1;
    deps.imSendFailCounts.set(imJid, count);
    if (count >= IM_SEND_FAIL_THRESHOLD) {
      try {
        unbindImGroup(
          imJid,
          'Auto-unbound IM group after consecutive send failures',
        );
      } catch (unbindErr) {
        logger.error({ imJid, unbindErr }, 'Failed to auto-unbind IM group');
      }
    }
    return false;
  }

  function sendImWithFailTracking(
    imJid: string,
    text: string,
    localImagePaths: string[],
  ): void {
    sendImWithRetry(imJid, text, localImagePaths).catch(() => {});
  }

  function buildOnNewChat(
    userId: string,
    homeFolder: string,
  ): (chatJid: string, chatName: string) => void {
    return (chatJid, chatName) => {
      const existing = deps.registeredGroups[chatJid];
      if (existing) {
        if (existing.created_by === userId) return;
        if (existing.target_agent_id || existing.target_main_jid) return;

        if (!existing.created_by) {
          existing.created_by = userId;
          setRegisteredGroup(chatJid, existing);
          deps.registeredGroups[chatJid] = existing;
          logger.info(
            { chatJid, chatName, userId, folder: existing.folder },
            'Backfilled created_by for IM chat (preserved existing folder)',
          );
          return;
        }

        if (!existing.is_home) {
          const previousOwner = existing.created_by;
          const channelType = getChannelType(chatJid);
          const previousOwnerStillConnected = channelType
            ? imManager
                .getConnectedChannelTypes(previousOwner)
                .includes(channelType)
            : false;

          if (previousOwnerStillConnected) {
            logger.debug(
              {
                chatJid,
                chatName,
                userId,
                channelType,
                existingOwner: previousOwner,
                existingFolder: existing.folder,
              },
              'Skipped IM chat re-route (previous owner still connected on same channel type)',
            );
          } else {
            const previousFolder = existing.folder;
            existing.folder = homeFolder;
            existing.created_by = userId;
            setRegisteredGroup(chatJid, existing);
            deps.registeredGroups[chatJid] = existing;
            logger.info(
              {
                chatJid,
                chatName,
                userId,
                homeFolder,
                previousFolder,
                previousOwner,
                channelType,
              },
              'Re-routed IM chat to new user (IM credentials transferred)',
            );
          }
        }
        return;
      }
      deps.registerGroup(chatJid, {
        name: chatName,
        folder: homeFolder,
        added_at: new Date().toISOString(),
        created_by: userId,
      });
      logger.info(
        { chatJid, chatName, userId, homeFolder },
        'Auto-registered IM chat',
      );
    };
  }

  function buildOnBotRemovedFromGroup(): (chatJid: string) => void {
    return (chatJid: string) => {
      unbindImGroup(
        chatJid,
        'Auto-unbound IM group: bot removed or group disbanded',
      );
    };
  }

  function buildTelegramBotAddedHandler(
    userId: string,
    homeFolder: string,
  ): (chatJid: string, chatName: string) => void {
    const onNewChat = buildOnNewChat(userId, homeFolder);
    return (chatJid: string, chatName: string) => {
      onNewChat(chatJid, chatName);
      const welcome =
        `已加入「${chatName}」！当前绑定到默认工作区。\n\n` +
        `/new <名称> — 新建工作区并绑定此群\n` +
        `/bind <工作区> — 绑定到已有工作区\n` +
        `/list — 查看所有工作区\n\n` +
        `也可以直接发消息，我会在默认工作区回复。`;
      imManager
        .sendMessage(chatJid, welcome)
        .catch((err) =>
          logger.warn(
            { chatJid, err },
            'Failed to send Telegram group welcome message',
          ),
        );
    };
  }

  function buildIsChatAuthorized(userId: string): (jid: string) => boolean {
    return (jid) => {
      const group = deps.registeredGroups[jid];
      return !!group && group.created_by === userId;
    };
  }

  function buildOnPairAttempt(
    userId: string,
  ): (jid: string, chatName: string, code: string) => Promise<boolean> {
    return async (jid, chatName, code) => {
      const result = verifyPairingCode(code);
      if (!result) return false;
      if (result.userId !== userId) return false;
      const pairingUserHome = getUserHomeGroup(result.userId);
      if (!pairingUserHome) return false;
      buildOnNewChat(result.userId, pairingUserHome.folder)(jid, chatName);
      return true;
    };
  }

  function buildResolveEffectiveChatJid(): (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null {
    return (chatJid: string) => {
      const group =
        deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
      if (!group) return null;

      if (group.target_agent_id) {
        const agent = getAgent(group.target_agent_id);
        if (!agent) return null;
        const effectiveJid = `${agent.chat_jid}#agent:${group.target_agent_id}`;
        return { effectiveJid, agentId: group.target_agent_id };
      }

      if (group.target_main_jid) {
        let effectiveJid = group.target_main_jid;
        if (
          !deps.registeredGroups[effectiveJid] &&
          !getRegisteredGroup(effectiveJid) &&
          effectiveJid.startsWith('web:')
        ) {
          const folder = effectiveJid.slice(4);
          const jids = getJidsByFolder(folder);
          for (const j of jids) {
            if (j.startsWith('web:')) {
              effectiveJid = j;
              break;
            }
          }
        }
        return { effectiveJid, agentId: null };
      }

      return null;
    };
  }

  function buildOnAgentMessage(): (
    baseChatJid: string,
    agentId: string,
  ) => void {
    return (baseChatJid: string, agentId: string) => {
      const group =
        deps.registeredGroups[baseChatJid] ?? getRegisteredGroup(baseChatJid);
      if (!group) return;

      const agent = getAgent(agentId);
      const homeChatJid = agent?.chat_jid || `web:${group.folder}`;
      const virtualChatJid = `${homeChatJid}#agent:${agentId}`;
      const sinceCursor =
        deps.lastAgentTimestamp[virtualChatJid] || deps.emptyCursor;
      const missedMessages = getMessagesSince(virtualChatJid, sinceCursor);
      const lastSourceJid =
        missedMessages[missedMessages.length - 1]?.source_jid;
      const isImSource =
        !!lastSourceJid && getChannelType(lastSourceJid) !== null;

      if (isImSource) {
        deps.queue.closeStdin(virtualChatJid);
        const taskId = `agent-im-restart:${agentId}`;
        deps.queue.enqueueTask(virtualChatJid, taskId, async () => {
          await deps.processAgentConversation(homeChatJid, agentId);
        });
      } else {
        const formatted =
          missedMessages.length > 0
            ? deps.formatMessages(missedMessages, false)
            : '';
        const images = deps.collectMessageImages(
          virtualChatJid,
          missedMessages,
        );
        const imagesForAgent = images.length > 0 ? images : undefined;

        const sendResult = formatted
          ? deps.queue.sendMessage(
              virtualChatJid,
              formatted,
              imagesForAgent,
              undefined,
              {
                chatJid: homeChatJid,
              },
            )
          : 'no_active';
        if (sendResult === 'no_active') {
          const taskId = `agent-conv:${agentId}:${Date.now()}`;
          deps.queue.enqueueTask(virtualChatJid, taskId, async () => {
            await deps.processAgentConversation(homeChatJid, agentId);
          });
        }
      }
      logger.info(
        {
          baseChatJid,
          homeChatJid,
          agentId,
          messageCount: missedMessages.length,
        },
        'IM message triggered agent conversation processing',
      );
    };
  }

  function shouldProcessGroupMessage(chatJid: string): boolean {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return false;

    const mode = group.activation_mode ?? 'auto';
    switch (mode) {
      case 'always':
        return true;
      case 'when_mentioned':
        return false;
      case 'disabled':
        return false;
      case 'auto':
      default:
        return group.require_mention !== true;
    }
  }

  function handleCardInterrupt(chatJid: string): void {
    const interrupted = deps.queue.interruptQuery(chatJid);
    if (interrupted) {
      logger.info({ chatJid }, 'Card interrupt: query interrupted');
    }

    const session = getStreamingSession(chatJid);
    if (session?.isActive()) {
      session.abort('用户中断').catch((err) => {
        logger.debug({ err, chatJid }, 'Failed to abort streaming card');
      });
    }
  }

  async function connectUserIMChannels(
    userId: string,
    homeFolder: string,
    feishuConfig?: FeishuConnectConfig | null,
    telegramConfig?: TelegramConnectConfig | null,
    qqConfig?: QQConnectConfig | null,
    wechatConfig?: WeChatConnectConfig | null,
    ignoreMessagesBefore?: number,
  ): Promise<{
    feishu: boolean;
    telegram: boolean;
    qq: boolean;
    wechat: boolean;
  }> {
    const onNewChat = buildOnNewChat(userId, homeFolder);
    const resolveGroupFolder = (chatJid: string): string | undefined =>
      resolveEffectiveFolder(chatJid);
    const resolveEffectiveChatJid = buildResolveEffectiveChatJid();
    const onAgentMessage = buildOnAgentMessage();
    const onBotAddedToGroup = buildOnNewChat(userId, homeFolder);
    const onBotRemovedFromGroup = buildOnBotRemovedFromGroup();

    let feishu = false;
    let telegram = false;
    let qq = false;
    let wechat = false;

    if (
      feishuConfig &&
      feishuConfig.enabled !== false &&
      feishuConfig.appId &&
      feishuConfig.appSecret
    ) {
      feishu = await imManager.connectUserFeishu(
        userId,
        feishuConfig,
        onNewChat,
        {
          ignoreMessagesBefore,
          onCommand: deps.handleCommand,
          resolveGroupFolder,
          resolveEffectiveChatJid,
          onAgentMessage,
          onBotAddedToGroup,
          onBotRemovedFromGroup,
          shouldProcessGroupMessage,
          onCardInterrupt: handleCardInterrupt,
        } satisfies ConnectFeishuOptions,
      );
    }

    if (
      telegramConfig &&
      telegramConfig.enabled !== false &&
      telegramConfig.botToken
    ) {
      telegram = await imManager.connectUserTelegram(
        userId,
        telegramConfig,
        onNewChat,
        buildIsChatAuthorized(userId),
        buildOnPairAttempt(userId),
        {
          onCommand: deps.handleCommand,
          ignoreMessagesBefore,
          resolveGroupFolder,
          resolveEffectiveChatJid,
          onAgentMessage,
          onBotAddedToGroup: buildTelegramBotAddedHandler(userId, homeFolder),
          onBotRemovedFromGroup,
        },
      );
    }

    if (
      qqConfig &&
      qqConfig.enabled !== false &&
      qqConfig.appId &&
      qqConfig.appSecret
    ) {
      qq = await imManager.connectUserQQ(
        userId,
        qqConfig,
        onNewChat,
        buildIsChatAuthorized(userId),
        buildOnPairAttempt(userId),
        {
          onCommand: deps.handleCommand,
          resolveGroupFolder,
          resolveEffectiveChatJid,
          onAgentMessage,
        },
      );
    }

    if (
      wechatConfig &&
      wechatConfig.enabled !== false &&
      wechatConfig.botToken &&
      wechatConfig.ilinkBotId
    ) {
      wechat = await imManager.connectUserWeChat(
        userId,
        wechatConfig,
        onNewChat,
        {
          ignoreMessagesBefore,
          onCommand: deps.handleCommand,
          resolveGroupFolder,
          resolveEffectiveChatJid,
          onAgentMessage,
        },
      );
    }

    return { feishu, telegram, qq, wechat };
  }

  return {
    unbindImGroup,
    resolveEffectiveFolder,
    resolveEffectiveGroup,
    resolveOwnerHomeFolder,
    extractLocalImImagePaths,
    retryImOperation,
    sendImWithRetry,
    sendImWithFailTracking,
    setActiveImReplyRoute,
    clearActiveImReplyRoute,
    buildOnNewChat,
    buildOnBotRemovedFromGroup,
    buildTelegramBotAddedHandler,
    buildIsChatAuthorized,
    buildOnPairAttempt,
    buildResolveEffectiveChatJid,
    buildOnAgentMessage,
    shouldProcessGroupMessage,
    handleCardInterrupt,
    connectUserIMChannels,
  };
}

export { IM_HEALTH_CHECK_FAIL_THRESHOLD };

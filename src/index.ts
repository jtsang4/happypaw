import { ChildProcess } from 'child_process';
import crypto from 'crypto';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { LEGACY_AGENT_SENDER } from './legacy-product.js';
import { interruptibleSleep } from './message-notifier.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';
import {
  runContainerAgent,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createTask,
  deleteTask,
  ensureChatExists,
  getAllTasks,
  getAllRegisteredGroups,
  getRegisteredGroup,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  isGroupShared,
  setSession,
  deleteSession,
  storeMessageDirect,
  updateLatestMessageTokenUsage,
  updateChatName,
  getAgent,
  updateAgentStatus,
  updateAgentLastImJid,
  deleteCompletedAgents,
  getRunningTaskAgentsByChat,
  markAllRunningTaskAgentsAsError,
  markStaleSpawnAgentsAsError,
  listActiveConversationAgents,
  getSession,
  getRuntimeSession,
  getGroupsByOwner,
  addGroupMember,
  cleanupOldDailyUsage,
  cleanupOldBillingAuditLog,
  insertUsageRecord,
  updateTask,
} from './db.js';
// feishu.js deprecated exports are no longer needed; imManager handles all connections
import { imManager } from './im-manager.js';
import { getChannelType } from './im-channel.js';
import {
  registerStreamingSession,
  unregisterStreamingSession,
  hasActiveStreamingSession,
  abortAllStreamingSessions,
  registerMessageIdMapping,
  getStreamingSession,
} from './feishu-streaming-card.js';
import {
  formatContextMessages,
  formatWorkspaceList,
  formatSystemStatus,
  resolveLocationInfo,
  type WorkspaceInfo,
} from './im-command-utils.js';
import { getSystemSettings } from './runtime-config.js';
import { GroupQueue } from './group-queue.js';
import {
  checkBillingAccessFresh,
  formatBillingAccessDeniedMessage,
  updateUsage,
  deductUsageCost,
} from './billing.js';
import {
  AgentStatus,
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
} from './types.js';
import { logger } from './logger.js';
import {
  ensureAgentDirectories,
  isSystemMaintenanceNoise,
  stripAgentInternalTags,
  stripVirtualJidSuffix,
} from './utils.js';
import {
  broadcastToWebClients,
  broadcastNewMessage,
  broadcastTyping,
  broadcastStreamEvent,
  broadcastAgentStatus,
  broadcastBillingUpdate,
  getActiveStreamingTexts,
} from './web.js';
import { installSkillForUser, deleteSkillForUser } from './routes/skills.js';
import {
  clearPersistedRuntimeStateForRecovery,
  clearSessionRuntimeFiles,
} from './runtime-state-cleanup.js';
import {
  EMPTY_CURSOR,
  buildInterruptedReply,
  buildOverflowPartialReply,
  createCursorStateHelpers,
  createStreamingBufferManager,
  isCursorAfter,
  recoverConversationAgents as recoverConversationAgentsHelper,
  recoverPendingMessages as recoverPendingMessagesHelper,
  recoverStuckPendingGroups as recoverStuckPendingGroupsHelper,
} from './index-recovery.js';
import { createIndexBootstrap } from './index-bootstrap.js';
import { createIndexStateBootstrap } from './index-bootstrap-state.js';
import { createSlashCommandHandlers } from './index-slash-commands.js';
import {
  createImRoutingHelpers,
  type ReplyRouteUpdater,
} from './index-im-routing.js';
import {
  collectMessageImages,
  createMainConversationRuntime,
  feedStreamEventToCard,
  formatMessages,
} from './index-main-conversation-runtime.js';
import { createMessageLoop } from './index-message-loop.js';
import { createIpcRuntime } from './index-ipc-runtime.js';
import { createIndexAgentRuntimeAdapter } from './index-agent-runtime-adapter.js';

const OOM_EXIT_RE = /code 137/;

let globalMessageCursor: MessageCursor = { timestamp: '', id: '' };
let sessions: Record<string, RuntimeSessionRecord> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, MessageCursor> = {};
// Recovery-safe cursor: only advances when an agent actually finishes processing.
// recoverPendingMessages() uses this to detect IPC-injected but unprocessed messages.
let lastCommittedCursor: Record<string, MessageCursor> = {};
let shuttingDown = false;
/** JIDs already persisted by the shutdown handler — prevents finally blocks from duplicating. */
const shutdownSavedJids = new Set<string>();

const queue = new GroupQueue();
const terminalWarmupInFlight = new Set<string>();
const STUCK_RUNNER_CHECK_INTERVAL_POLLS = 15;
const STUCK_RUNNER_IDLE_MS = 6 * 60 * 1000;
let stuckRunnerCheckCounter = 0;

// OOM auto-recovery: track consecutive OOM (exit code 137) exits per folder.
// After OOM_AUTO_RESET_THRESHOLD consecutive OOMs, auto-clear the session.
const consecutiveOomExits: Record<string, number> = {};
const OOM_AUTO_RESET_THRESHOLD = 2;

// Per-folder reply route updater: lets sendMessage callers update the
// reply routing of a running processGroupMessages without killing the process.
// Key is group folder (one active processGroupMessages per folder).
const activeRouteUpdaters = new Map<string, ReplyRouteUpdater>();

// Per-folder IM reply route: tracks the current replySourceImJid for each
// running processGroupMessages.  IPC watcher reads this to forward send_message
// outputs to the correct IM channel (the running session holds the truth).
const activeImReplyRoutes = new Map<string, string | null>();

// Track consecutive IM send failures per JID for auto-unbind
const imSendFailCounts = new Map<string, number>();

// Groups whose pending messages were recovered after a restart.
// processGroupMessages injects recent conversation history for these groups
// so the fresh session has context despite the session being cleared.
const recoveryGroups = new Set<string>();

// Track consecutive IM health check failures per JID for safe auto-unbind
const imHealthCheckFailCounts = new Map<string, number>();
let bootstrap: ReturnType<typeof createIndexBootstrap>;
let ipcRuntime: ReturnType<typeof createIpcRuntime>;

const { setCursors, advanceCursors } = createCursorStateHelpers({
  getLastAgentTimestamp: () => lastAgentTimestamp,
  getLastCommittedCursor: () => lastCommittedCursor,
  saveState: () => saveState(),
});

const {
  cleanStreamingBufferDir,
  flushStreamingBuffer,
  saveInterruptedStreamingMessages,
  recoverStreamingBuffer,
  startStreamingBuffer,
  stopStreamingBuffer,
} = createStreamingBufferManager({
  dataDir: DATA_DIR,
  assistantName: ASSISTANT_NAME,
  shutdownSavedJids,
  logger,
  getActiveStreamingTexts,
  ensureChatExists,
  storeMessageDirect,
});

const {
  getAvailableGroups,
  loadState,
  migrateDataDirectories,
  migrateSystemIMToPerUser,
  registerGroup,
  saveState,
  syncGroupMetadata,
} = createIndexStateBootstrap({
  getGlobalMessageCursor: () => globalMessageCursor,
  setGlobalMessageCursor: (cursor) => {
    globalMessageCursor = cursor;
  },
  lastAgentTimestamp,
  lastCommittedCursor,
  sessions,
  registeredGroups,
  consecutiveOomExits,
});

let handleCommand: (
  chatJid: string,
  command: string,
) => Promise<string | null> = async () => null;
let handleSpawnCommand: (
  chatJid: string,
  rawMessage: string,
  sourceImJid?: string,
) => Promise<string> = async () =>
  '用法: /sw <任务描述>\n在当前工作区创建并行任务';

const {
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
} = createImRoutingHelpers({
  queue,
  registerGroup,
  registeredGroups,
  imSendFailCounts,
  imHealthCheckFailCounts,
  lastAgentTimestamp,
  activeImReplyRoutes,
  activeRouteUpdaters,
  handleCommand: (chatJid, command) => handleCommand(chatJid, command),
  processAgentConversation,
  formatMessages,
  collectMessageImages,
  emptyCursor: EMPTY_CURSOR,
});

({ handleCommand, handleSpawnCommand } = createSlashCommandHandlers({
  queue,
  sessions,
  registeredGroups,
  imSendFailCounts,
  imHealthCheckFailCounts,
  setCursors,
  registerGroup,
  unbindImGroup,
  resolveEffectiveGroup,
  processAgentConversation,
}));

function recoverStuckPendingGroups(): void {
  recoverStuckPendingGroupsHelper({
    queue,
    logger,
    idleThresholdMs: STUCK_RUNNER_IDLE_MS,
  });
}

function recoverPendingMessages(): void {
  recoverPendingMessagesHelper({
    logger,
    queue,
    recoveryGroups,
    getRegisteredGroups: () => registeredGroups,
    getLastCommittedCursor: () => lastCommittedCursor,
    getSessions: () => sessions,
    getMessagesSince,
    clearPersistedRuntimeStateForRecovery,
  });
}

function recoverConversationAgents(): void {
  recoverConversationAgentsHelper({
    logger,
    queue,
    assistantName: ASSISTANT_NAME,
    emptyCursor: EMPTY_CURSOR,
    getLastAgentTimestamp: () => lastAgentTimestamp,
    getSessions: () => sessions,
    listActiveConversationAgents,
    updateAgentStatus,
    broadcastAgentStatus,
    getMessagesSince,
    getRuntimeSession,
    clearPersistedRuntimeStateForRecovery,
    storeMessageDirect,
    broadcastNewMessage,
    processAgentConversation,
  });
}

const {
  runAgent,
  getEffectiveRuntime,
  sendBillingDeniedMessage,
  setTyping,
  sendMessage,
  sendSystemMessage,
  writeUsageRecords,
  ensureTerminalContainerStarted,
} = createIndexAgentRuntimeAdapter({
  assistantName: ASSISTANT_NAME,
  queue,
  registeredGroups,
  sessions,
  terminalWarmupInFlight,
  getIpcRuntime: () => ipcRuntime,
  getAvailableGroups,
  getAllTasks,
  activeImReplyRoutes,
  hasActiveStreamingSession,
  imManager,
  getChannelType,
  ensureChatExists,
  storeMessageDirect,
  broadcastNewMessage,
  broadcastToWebClients,
  broadcastTyping,
  broadcastStreamEvent,
  extractLocalImImagePaths,
  resolveEffectiveFolder,
  resolveOwnerHomeFolder,
  getSystemSettings,
  insertUsageRecord,
  setSession,
  runHostAgent,
  runContainerAgent,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  logger,
});

const { startMessageLoop } = createMessageLoop({
  queue,
  pollInterval: POLL_INTERVAL,
  emptyCursor: EMPTY_CURSOR,
  registeredGroups,
  lastAgentTimestamp,
  recoveryGroups,
  getGlobalMessageCursor: () => globalMessageCursor,
  setGlobalMessageCursor: (cursor) => {
    globalMessageCursor = cursor;
  },
  saveState,
  setCursors,
  getStuckRunnerCheckCounter: () => stuckRunnerCheckCounter,
  resetStuckRunnerCheckCounter: () => {
    stuckRunnerCheckCounter = 0;
  },
  incrementStuckRunnerCheckCounter: () => ++stuckRunnerCheckCounter,
  stuckRunnerCheckIntervalPolls: STUCK_RUNNER_CHECK_INTERVAL_POLLS,
  recoverStuckPendingGroups,
  isShuttingDown: () => shuttingDown,
  formatMessages,
  collectMessageImages,
  isGroupShared,
  sendBillingDeniedMessage,
  imManager,
  activeRouteUpdaters,
});

const { processGroupMessages } = createMainConversationRuntime({
  registeredGroups,
  sessions,
  lastAgentTimestamp,
  recoveryGroups,
  activeRouteUpdaters,
  shutdownSavedJids,
  consecutiveOomExits,
  oomExitRe: OOM_EXIT_RE,
  oomAutoResetThreshold: OOM_AUTO_RESET_THRESHOLD,
  resolveEffectiveGroup,
  setActiveImReplyRoute,
  clearActiveImReplyRoute,
  advanceCursors,
  isGroupShared,
  closeStdin: (chatJid) => queue.closeStdin(chatJid),
  runAgent,
  getEffectiveRuntime,
  sendBillingDeniedMessage,
  setTyping,
  sendMessage,
  sendSystemMessage,
  extractLocalImImagePaths,
  sendImWithFailTracking,
  writeUsageRecords,
});

ipcRuntime = createIpcRuntime({
  dataDir: DATA_DIR,
  groupsDir: GROUPS_DIR,
  mainGroupFolder: MAIN_GROUP_FOLDER,
  timezone: TIMEZONE,
  assistantName: ASSISTANT_NAME,
  getRegisteredGroups: () => registeredGroups,
  getShuttingDown: () => shuttingDown,
  getActiveImReplyRoute: (folder) => activeImReplyRoutes.get(folder),
  sendMessage,
  ensureChatExists,
  storeMessageDirect,
  broadcastNewMessage,
  broadcastToWebClients,
  extractLocalImImagePaths,
  sendImWithFailTracking,
  retryImOperation,
  getChannelType,
  getGroupsByOwner,
  getConnectedChannelTypes: (userId) =>
    imManager.getConnectedChannelTypes(userId),
  sendImage: (jid, imageBuffer, mimeType, caption, fileName) =>
    imManager.sendImage(jid, imageBuffer, mimeType, caption, fileName),
  sendFile: (jid, filePath, fileName) =>
    imManager.sendFile(jid, filePath, fileName),
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
  syncGroupMetadata,
  getAvailableGroups,
  writeGroupsSnapshot,
  registerGroup,
  installSkillForUser,
  deleteSkillForUser,
});

bootstrap = createIndexBootstrap({
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
  getGlobalMessageCursor: () => globalMessageCursor,
  handleCardInterrupt,
  handleCommand: (chatJid, command) => handleCommand(chatJid, command),
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
  resolveEffectiveFolder: (chatJid) => resolveEffectiveFolder(chatJid) || '',
  resolveEffectiveGroup: (group) => resolveEffectiveGroup(group),
  saveInterruptedStreamingMessages,
  saveState,
  sessions,
  setCursors,
  setGlobalMessageCursor: (cursor) => {
    globalMessageCursor = cursor;
  },
  setShuttingDown: (value) => {
    shuttingDown = value;
  },
  setTyping,
  shouldProcessGroupMessage,
  startMessageLoop,
  startStreamingBuffer,
  stopStreamingBuffer,
  syncGroupMetadata,
  unbindImGroup,
  sendMessage,
  sendSystemMessage,
});
bootstrap.start().catch((err) => {
  logger.error({ err }, 'Failed to start happypaw');
  process.exit(1);
});

/**
 * Process messages for a user-created conversation agent.
 * Similar to processGroupMessages but uses agent-specific session/IPC and virtual JID.
 * The agent process stays alive for idleTimeout, cycling idle→running.
 */
async function processAgentConversation(
  chatJid: string,
  agentId: string,
): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent || (agent.kind !== 'conversation' && agent.kind !== 'spawn')) {
    logger.warn(
      { chatJid, agentId },
      'processAgentConversation: agent not found or not a conversation/spawn',
    );
    return;
  }

  let group = registeredGroups[chatJid];
  if (!group) {
    Object.keys(registeredGroups).forEach((key) => {
      delete registeredGroups[key];
    });
    Object.assign(registeredGroups, getAllRegisteredGroups());
    group = registeredGroups[chatJid];
  }
  if (!group) return;

  const { effectiveGroup } = resolveEffectiveGroup(group);

  const virtualChatJid = `${chatJid}#agent:${agentId}`;
  const virtualJid = virtualChatJid; // used as queue key

  // Get pending messages
  const sinceCursor = lastAgentTimestamp[virtualChatJid] || EMPTY_CURSOR;
  const missedMessages = getMessagesSince(virtualChatJid, sinceCursor);
  if (missedMessages.length === 0) {
    // Spawn agents are fire-and-forget: if no messages are found (race condition
    // or cursor already advanced), mark as error so they don't stay idle forever.
    if (agent.kind === 'spawn' && agent.status === 'idle') {
      updateAgentStatus(agentId, 'error', '未找到待处理消息');
      broadcastAgentStatus(
        chatJid,
        agentId,
        'error',
        agent.name,
        agent.prompt,
        '未找到待处理消息',
      );
      logger.warn(
        { chatJid, agentId },
        'Spawn agent had no pending messages, marked as error',
      );
    }
    return;
  }

  const isHome = !!effectiveGroup.is_home;
  const isAdminHome = isHome && effectiveGroup.folder === MAIN_GROUP_FOLDER;

  // Update agent status → running
  updateAgentStatus(agentId, 'running');
  broadcastAgentStatus(chatJid, agentId, 'running', agent.name, agent.prompt);

  const prompt = formatMessages(missedMessages, false);
  const images = collectMessageImages(virtualChatJid, missedMessages);
  const imagesForAgent = images.length > 0 ? images : undefined;
  // For agent conversations, route reply to IM based on the most recent
  // message's source.  Unlike the main conversation (#99), agent conversations
  // are explicitly bound to IM groups, so the user expects replies to go back
  // to the IM channel they last messaged from — even if older messages in
  // the batch originated from the web (e.g. after a /clear).
  let replySourceImJid: string | null = null;
  {
    const lastSourceJid = missedMessages[missedMessages.length - 1]?.source_jid;
    if (lastSourceJid && getChannelType(lastSourceJid) !== null) {
      replySourceImJid = lastSourceJid;
    }
  }

  // Fallback: if no IM source in current messages (e.g. web "继续" after
  // restart), recover from the persisted last_im_jid in the DB (#225).
  // Verify the channel is actually connected — stale JIDs from disabled
  // channels would cause unnecessary retries and eventual auto-unbind.
  if (!replySourceImJid) {
    const agentRow = getAgent(agentId);
    if (agentRow?.last_im_jid) {
      if (imManager.isChannelAvailableForJid(agentRow.last_im_jid)) {
        replySourceImJid = agentRow.last_im_jid;
        logger.info(
          { chatJid, agentId, recoveredImJid: replySourceImJid },
          'Recovered IM routing from persisted last_im_jid',
        );
      } else {
        logger.info(
          { chatJid, agentId, staleImJid: agentRow.last_im_jid },
          'Skipped last_im_jid recovery: channel disconnected',
        );
      }
    }
  }

  // Persist the IM routing target so it survives service restarts.
  if (replySourceImJid) {
    updateAgentLastImJid(agentId, replySourceImJid);
  }

  // ── Feishu Streaming Card (conversation agent) ──
  // Unlike processGroupMessages which falls back to chatJid, conversation agents
  // only stream when the message originates from an IM channel (replySourceImJid).
  // Web-only interactions don't need a Feishu streaming card.
  // Use agent-scoped key to avoid colliding with the main session's streaming card (#242).
  const streamingSessionJid = replySourceImJid
    ? `${replySourceImJid}#agent:${agentId}`
    : undefined;
  let agentStreamingSession = replySourceImJid
    ? imManager.createStreamingSession(replySourceImJid, (messageId) =>
        registerMessageIdMapping(messageId, streamingSessionJid!),
      )
    : undefined;
  let agentStreamingAccText = '';
  let agentStreamInterrupted = false;
  if (agentStreamingSession && streamingSessionJid) {
    registerStreamingSession(streamingSessionJid, agentStreamingSession);
    logger.debug(
      { chatJid, agentId },
      'Streaming card session created for conversation agent',
    );
  }

  // Track idle timer
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { agentId, chatJid },
        'Agent conversation idle timeout, closing stdin',
      );
      queue.closeStdin(virtualJid);
    }, getSystemSettings().idleTimeout);
  };

  let cursorCommitted = false;
  let hadError = false;
  let lastError = '';
  let lastAgentReplyMsgId: string | undefined;
  let lastAgentReplyText: string | undefined;
  let output: ContainerOutput | undefined;
  const lastProcessed = missedMessages[missedMessages.length - 1];
  const commitCursor = (): void => {
    if (cursorCommitted) return;
    advanceCursors(virtualChatJid, {
      timestamp: lastProcessed.timestamp,
      id: lastProcessed.id,
    });
    cursorCommitted = true;
  };

  const runtime = getEffectiveRuntime(effectiveGroup);
  const sessionRecord = getRuntimeSession(effectiveGroup.folder, agentId);
  const sessionId =
    sessionRecord && sessionRecord.runtime === runtime
      ? sessionRecord.sessionId
      : undefined;
  let currentAgentSessionId = sessionId;

  const wrappedOnOutput = async (output: ContainerOutput) => {
    // Track session
    if (output.newSessionId && output.status !== 'error') {
      setSession(effectiveGroup.folder, output.newSessionId, agentId, runtime);
      currentAgentSessionId = output.newSessionId;
    }

    // Stream events
    if (output.status === 'stream' && output.streamEvent) {
      broadcastStreamEvent(chatJid, output.streamEvent, agentId);

      // ── 累积 text_delta 文本（中断时用于保存已输出内容）──
      if (
        output.streamEvent.eventType === 'text_delta' &&
        output.streamEvent.text
      ) {
        agentStreamingAccText += output.streamEvent.text;
      }

      // ── Feed stream events into Feishu streaming card ──
      if (agentStreamingSession) {
        feedStreamEventToCard(
          agentStreamingSession,
          output.streamEvent,
          agentStreamingAccText,
        );
      }

      // ── 中断时立即保存已输出内容 ──
      if (
        output.streamEvent.eventType === 'status' &&
        output.streamEvent.statusText === 'interrupted'
      ) {
        agentStreamInterrupted = true;
        if (!cursorCommitted) {
          const interruptedText = buildInterruptedReply(agentStreamingAccText);
          try {
            if (agentStreamingSession?.isActive()) {
              await agentStreamingSession.abort('已中断').catch(() => {});
            }
            const msgId = crypto.randomUUID();
            const timestamp = new Date().toISOString();
            ensureChatExists(virtualChatJid);
            const persistedMsgId = storeMessageDirect(
              msgId,
              virtualChatJid,
              'happypaw-agent',
              ASSISTANT_NAME,
              interruptedText,
              timestamp,
              true,
              {
                meta: {
                  turnId: output.streamEvent.turnId || lastProcessed.id,
                  sessionId:
                    output.streamEvent.sessionId || currentAgentSessionId,
                  sourceKind: 'interrupt_partial',
                  finalizationReason: 'interrupted',
                },
              },
            );
            broadcastNewMessage(
              virtualChatJid,
              {
                id: persistedMsgId,
                chat_jid: virtualChatJid,
                sender: 'happypaw-agent',
                sender_name: ASSISTANT_NAME,
                content: interruptedText,
                timestamp,
                is_from_me: true,
                turn_id: output.streamEvent.turnId || lastProcessed.id,
                session_id:
                  output.streamEvent.sessionId || currentAgentSessionId,
                sdk_message_uuid: null,
                source_kind: 'interrupt_partial',
                finalization_reason: 'interrupted',
              },
              agentId,
            );
            commitCursor();
          } catch (err) {
            logger.warn(
              { err, chatJid, agentId },
              'Failed to save interrupted agent text on status event',
            );
          }
        }
      }

      // Persist token usage for agent conversations
      if (
        output.streamEvent.eventType === 'usage' &&
        output.streamEvent.usage
      ) {
        try {
          updateLatestMessageTokenUsage(
            virtualChatJid,
            JSON.stringify(output.streamEvent.usage),
            lastAgentReplyMsgId,
          );

          // Write to usage_records + usage_daily_summary
          // Sub-Agent 的 effectiveGroup 可能没有 created_by，从父群组继承
          writeUsageRecords({
            userId:
              effectiveGroup.created_by ||
              registeredGroups[chatJid]?.created_by ||
              'system',
            groupFolder: effectiveGroup.folder,
            agentId,
            messageId: lastAgentReplyMsgId,
            usage: output.streamEvent.usage,
          });
        } catch (err) {
          logger.warn(
            { err, chatJid, agentId },
            'Failed to persist agent conversation token usage',
          );
        }
      }

      // Reset idle timer on stream events so long-running tool calls
      // don't get killed while the agent is actively working.
      resetIdleTimer();
      return;
    }

    // Agent reply
    if (output.result) {
      const raw =
        typeof output.result === 'string'
          ? output.result
          : JSON.stringify(output.result);
      let text = stripAgentInternalTags(raw);
      if (
        output.sourceKind === 'overflow_partial' ||
        output.sourceKind === 'compact_partial'
      ) {
        // Spawn agents are fire-and-forget: context compression is an internal
        // detail. Don't append the "上下文压缩中" suffix — it confuses users
        // seeing the Feishu card suddenly change to a warning.
        if (agent.kind !== 'spawn') {
          text = buildOverflowPartialReply(text);
        }
      }
      // Suppress system-maintenance noise from auto_continue outputs (issue #275).
      // Short acknowledgements ("OK", "已更新 CLAUDE.md") that leak from the
      // compaction pipeline are dropped; substantive continuations pass through.
      if (
        output.sourceKind === 'auto_continue' &&
        isSystemMaintenanceNoise(text)
      ) {
        logger.info(
          { chatJid, agentId, textLen: text.length },
          'auto_continue output suppressed (system maintenance noise)',
        );
        return;
      }
      if (text) {
        const isFirstReply = !lastAgentReplyMsgId;
        const msgId = crypto.randomUUID();
        lastAgentReplyMsgId = msgId;
        lastAgentReplyText = text;
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        const persistedMsgId = storeMessageDirect(
          msgId,
          virtualChatJid,
          'happypaw-agent',
          ASSISTANT_NAME,
          text,
          timestamp,
          true,
          {
            meta: {
              turnId: output.turnId || lastProcessed.id,
              sessionId: output.sessionId || currentAgentSessionId,
              sdkMessageUuid: output.sdkMessageUuid,
              sourceKind: output.sourceKind || 'sdk_final',
              finalizationReason: output.finalizationReason || 'completed',
            },
          },
        );
        broadcastNewMessage(
          virtualChatJid,
          {
            id: persistedMsgId,
            chat_jid: virtualChatJid,
            sender: 'happypaw-agent',
            sender_name: ASSISTANT_NAME,
            content: text,
            timestamp,
            is_from_me: true,
            turn_id: output.turnId || lastProcessed.id,
            session_id: output.sessionId || currentAgentSessionId,
            sdk_message_uuid: output.sdkMessageUuid ?? null,
            source_kind: output.sourceKind || 'sdk_final',
            finalization_reason: output.finalizationReason || 'completed',
          },
          agentId,
        );

        const localImagePaths = extractLocalImImagePaths(
          text,
          effectiveGroup.folder,
        );

        // ── Complete Feishu streaming card or fall back to static message ──
        let streamingCardHandledIM = false;
        if (agentStreamingSession?.isActive()) {
          try {
            await agentStreamingSession.complete(text);
            streamingCardHandledIM = true;
          } catch (err) {
            logger.warn(
              { err, chatJid, agentId },
              'Agent streaming card complete failed, falling back to static message',
            );
            await agentStreamingSession
              .abort('回复已通过消息发送')
              .catch(() => {});
          }
        }

        // ── Rebuild streaming card after compact_partial / overflow_partial ──
        // The completed card was consumed; create a new one so post-compaction
        // tool-call progress remains visible on Feishu (#223).
        if (
          streamingCardHandledIM &&
          (output.sourceKind === 'compact_partial' ||
            output.sourceKind === 'overflow_partial') &&
          streamingSessionJid
        ) {
          agentStreamingAccText = '';
          unregisterStreamingSession(streamingSessionJid);
          agentStreamingSession = imManager.createStreamingSession(
            replySourceImJid!,
            (messageId) =>
              registerMessageIdMapping(messageId, streamingSessionJid!),
          );
          if (agentStreamingSession) {
            registerStreamingSession(
              streamingSessionJid,
              agentStreamingSession,
            );
            logger.debug(
              { chatJid, agentId, sourceKind: output.sourceKind },
              'Rebuilt streaming card after partial output',
            );
          }
        }

        if (replySourceImJid && !streamingCardHandledIM && isFirstReply) {
          // Only send the FIRST substantive reply to IM. Subsequent results
          // (SDK Task completions) are stored in DB but not spammed to IM.
          const imSent = await sendImWithRetry(
            replySourceImJid,
            text,
            localImagePaths,
          );
          if (imSent) {
            logger.info(
              {
                chatJid,
                agentId,
                replySourceImJid,
                sourceKind: output.sourceKind,
                textLen: text.length,
              },
              'Agent conversation: static IM message sent',
            );
          } else {
            logger.error(
              {
                chatJid,
                agentId,
                replySourceImJid,
                sourceKind: output.sourceKind,
              },
              'Agent conversation: IM send failed after all retries, message lost',
            );
          }
        } else if (!replySourceImJid) {
          logger.debug(
            { chatJid, agentId, sourceKind: output.sourceKind },
            'Agent conversation: no replySourceImJid, skip IM delivery',
          );
        }

        // Optional mirror mode for linked IM channels
        for (const [imJid, g] of Object.entries(registeredGroups)) {
          if (g.target_agent_id !== agentId || imJid === replySourceImJid)
            continue;
          if (g.reply_policy !== 'mirror') continue;
          if (getChannelType(imJid))
            sendImWithFailTracking(imJid, text, localImagePaths);
        }

        commitCursor();
        resetIdleTimer();

        // Spawn agents are fire-and-forget: close after first reply to free process slot.
        // Skip for overflow_partial/compact_partial — those are intermediate context
        // compression outputs, not the final result; closing now would kill the agent
        // before it finishes the actual task.
        if (
          agent.kind === 'spawn' &&
          text &&
          output.sourceKind !== 'overflow_partial' &&
          output.sourceKind !== 'compact_partial'
        ) {
          logger.info(
            { agentId, chatJid },
            'Spawn agent replied, sending close signal',
          );
          queue.closeStdin(virtualChatJid);
        }
      }
    }

    if (output.status === 'error') {
      hadError = true;
      if (output.error) lastError = output.error;
    }
  };

  ipcRuntime.watchGroup(effectiveGroup.folder);
  try {
    const executionMode = effectiveGroup.executionMode || 'container';
    const onProcessCb = (proc: ChildProcess, identifier: string) => {
      const containerName = executionMode === 'container' ? identifier : null;
      queue.registerProcess(
        virtualJid,
        proc,
        containerName,
        effectiveGroup.folder,
        identifier,
        agentId,
      );
    };

    const containerInput: ContainerInput = {
      prompt,
      sessionId,
      runtime,
      turnId: lastProcessed.id,
      groupFolder: effectiveGroup.folder,
      chatJid,
      isMain: isAdminHome,
      isHome,
      isAdminHome,
      agentId,
      agentName: agent.name,
      images: imagesForAgent,
    };

    // Write tasks/groups snapshots
    const tasks = getAllTasks();
    writeTasksSnapshot(
      effectiveGroup.folder,
      isAdminHome,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );
    const availableGroups = getAvailableGroups();
    writeGroupsSnapshot(
      effectiveGroup.folder,
      isAdminHome,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );

    const ownerHomeFolder = resolveOwnerHomeFolder(effectiveGroup);

    if (executionMode === 'host') {
      output = await runHostAgent(
        effectiveGroup,
        containerInput,
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    } else {
      output = await runContainerAgent(
        effectiveGroup,
        containerInput,
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    }

    // Finalize session
    if (output.newSessionId && output.status !== 'error') {
      setSession(effectiveGroup.folder, output.newSessionId, agentId, runtime);
    }

    // 不可恢复的转录错误（如超大图片/MIME 错配被固化在会话历史中）
    const errorForReset = [lastError, output.error].filter(Boolean).join(' ');
    if (
      (output.status === 'error' || hadError) &&
      errorForReset.includes('unrecoverable_transcript:')
    ) {
      const detail = (lastError || output.error || '').replace(
        /.*unrecoverable_transcript:\s*/,
        '',
      );
      logger.warn(
        { chatJid, agentId, folder: effectiveGroup.folder, error: detail },
        'Unrecoverable transcript error in conversation agent, auto-resetting session',
      );

      await clearSessionRuntimeFiles(effectiveGroup.folder, agentId);
      try {
        deleteSession(effectiveGroup.folder, agentId);
      } catch (err) {
        logger.error(
          { chatJid, agentId, folder: effectiveGroup.folder, err },
          'Failed to clear agent session state during auto-reset',
        );
      }

      sendSystemMessage(
        virtualChatJid,
        'context_reset',
        `会话已自动重置：${detail}`,
      );
      commitCursor();
    }

    // Only commit cursor if a reply was actually sent.  Without a reply the
    // messages haven't been "processed" — leaving the cursor behind lets the
    // recovery logic pick them up after a restart.
    if (lastAgentReplyMsgId) {
      commitCursor();
    }
  } catch (err) {
    hadError = true;
    logger.error({ agentId, chatJid, err }, 'Agent conversation error');
  } finally {
    if (idleTimer) clearTimeout(idleTimer);

    const wasInterrupted = agentStreamInterrupted && !cursorCommitted;

    // ── Streaming card cleanup ──
    if (agentStreamingSession) {
      if (agentStreamingSession.isActive()) {
        if (hadError) {
          await agentStreamingSession.abort('处理出错').catch(() => {});
        } else if (wasInterrupted) {
          await agentStreamingSession.abort('已中断').catch(() => {});
        } else {
          agentStreamingSession.dispose();
        }
      }
      if (streamingSessionJid) {
        unregisterStreamingSession(streamingSessionJid);
      }
    }

    // ── 保存中断内容 ──
    if (wasInterrupted) {
      const interruptedText = buildInterruptedReply(agentStreamingAccText);
      try {
        const msgId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        const persistedMsgId = storeMessageDirect(
          msgId,
          virtualChatJid,
          'happypaw-agent',
          ASSISTANT_NAME,
          interruptedText,
          timestamp,
          true,
          {
            meta: {
              turnId: lastProcessed.id,
              sessionId: currentAgentSessionId,
              sourceKind: 'interrupt_partial',
              finalizationReason: 'interrupted',
            },
          },
        );
        broadcastNewMessage(
          virtualChatJid,
          {
            id: persistedMsgId,
            chat_jid: virtualChatJid,
            sender: 'happypaw-agent',
            sender_name: ASSISTANT_NAME,
            content: interruptedText,
            timestamp,
            is_from_me: true,
            turn_id: lastProcessed.id,
            session_id: currentAgentSessionId,
            sdk_message_uuid: null,
            source_kind: 'interrupt_partial',
            finalization_reason: 'interrupted',
          },
          agentId,
        );
        commitCursor();
      } catch (err) {
        logger.warn(
          { err, chatJid, agentId },
          'Failed to save interrupted agent text',
        );
      }
    }

    // ── 兜底：进程异常退出导致累积文本未持久化 ──
    if (
      !cursorCommitted &&
      output?.status !== 'closed' &&
      agentStreamingAccText.trim()
    ) {
      try {
        const partialReply = buildInterruptedReply(agentStreamingAccText);
        const msgId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        const persistedMsgId = storeMessageDirect(
          msgId,
          virtualChatJid,
          'happypaw-agent',
          ASSISTANT_NAME,
          partialReply,
          timestamp,
          true,
          {
            meta: {
              turnId: lastProcessed.id,
              sessionId: currentAgentSessionId,
              sourceKind: 'interrupt_partial',
              finalizationReason: 'error',
            },
          },
        );
        broadcastNewMessage(
          virtualChatJid,
          {
            id: persistedMsgId,
            chat_jid: virtualChatJid,
            sender: 'happypaw-agent',
            sender_name: ASSISTANT_NAME,
            content: partialReply,
            timestamp,
            is_from_me: true,
            turn_id: lastProcessed.id,
            session_id: currentAgentSessionId,
            sdk_message_uuid: null,
            source_kind: 'interrupt_partial',
            finalization_reason: 'error',
          },
          agentId,
        );
        commitCursor();
      } catch (err) {
        logger.warn(
          { err, chatJid, agentId },
          'Failed to save interrupted partial agent text',
        );
      }
    }

    // ── Spawn result injection: write final output back to the source chat ──
    if (
      agent.kind === 'spawn' &&
      agent.spawned_from_jid &&
      lastAgentReplyText
    ) {
      try {
        const resultText = lastAgentReplyText;
        const injectId = crypto.randomUUID();
        const injectTs = new Date().toISOString();
        ensureChatExists(agent.spawned_from_jid);
        storeMessageDirect(
          injectId,
          agent.spawned_from_jid,
          'happypaw-agent',
          ASSISTANT_NAME,
          resultText,
          injectTs,
          true,
        );
        broadcastNewMessage(agent.spawned_from_jid, {
          id: injectId,
          chat_jid: agent.spawned_from_jid,
          sender: 'happypaw-agent',
          sender_name: ASSISTANT_NAME,
          content: resultText,
          timestamp: injectTs,
          is_from_me: true,
        });
        logger.info(
          {
            agentId,
            spawned_from_jid: agent.spawned_from_jid,
            textLen: lastAgentReplyText.length,
          },
          'Spawn result injected back to source chat',
        );
      } catch (err) {
        logger.error(
          { agentId, err },
          'Failed to inject spawn result back to source chat',
        );
      }
    }

    // Process ended → set status back to idle (conversation agents persist).
    // Spawn agents are fire-and-forget: mark as completed (or error) so they
    // don't accumulate in the active agent list.
    // MUST be inside finally so status is reset even on unhandled exceptions (#227).
    const endStatus =
      agent.kind === 'spawn' ? (hadError ? 'error' : 'completed') : 'idle';
    updateAgentStatus(agentId, endStatus, hadError ? lastError : undefined);
    broadcastAgentStatus(
      chatJid,
      agentId,
      endStatus,
      agent.name,
      agent.prompt,
      hadError ? lastError : undefined,
    );

    ipcRuntime.unwatchGroup(effectiveGroup.folder);
  }
}

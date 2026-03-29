import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { interruptibleSleep } from './features/im/message-notifier.js';
import {
  runContainerAgent,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './features/execution/container-runner.js';
import {
  createTask,
  deleteTask,
  ensureChatExists,
  getAllTasks,
  getAgent,
  getRegisteredGroup,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  isGroupShared,
  setSession,
  storeMessageDirect,
  updateChatName,
  updateAgentStatus,
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
import { imManager } from './features/im/im-manager.js';
import { getChannelType } from './features/im/im-channel.js';
import {
  hasActiveStreamingSession,
  abortAllStreamingSessions,
  getStreamingSession,
} from './features/im/feishu/streaming-card/index.js';
import {
  formatContextMessages,
  formatWorkspaceList,
  formatSystemStatus,
  resolveLocationInfo,
  type WorkspaceInfo,
} from './features/im/im-command-utils.js';
import { getSystemSettings } from './runtime-config.js';
import { GroupQueue } from './features/chat-runtime/group-queue.js';
import {
  checkBillingAccessFresh,
  formatBillingAccessDeniedMessage,
  updateUsage,
  deductUsageCost,
} from './features/billing/billing.js';
import {
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
} from './types.js';
import { logger } from './logger.js';
import { ensureAgentDirectories, stripVirtualJidSuffix } from './utils.js';
import {
  broadcastToWebClients,
  broadcastNewMessage,
  broadcastTyping,
  broadcastStreamEvent,
  broadcastAgentStatus,
  broadcastBillingUpdate,
  getActiveStreamingTexts,
} from './web.js';
import {
  installSkillForUser,
  deleteSkillForUser,
} from './features/skills/routes/skills.js';
import { clearPersistedRuntimeStateForRecovery } from './features/chat-runtime/runtime-state-cleanup.js';
import {
  EMPTY_CURSOR,
  createCursorStateHelpers,
  createStreamingBufferManager,
  isCursorAfter,
  recoverConversationAgents as recoverConversationAgentsHelper,
  recoverPendingMessages as recoverPendingMessagesHelper,
  recoverStuckPendingGroups as recoverStuckPendingGroupsHelper,
} from './features/chat-runtime/recovery.js';
import { createBootstrapRuntime } from './features/chat-runtime/bootstrap.js';
import { createBootstrapStateRuntime } from './features/chat-runtime/bootstrap-state.js';
import { createSlashCommandHandlers } from './features/chat-runtime/slash-commands.js';
import {
  createImRoutingHelpers,
  resolveReplyRouteJid,
  type ReplyRouteUpdater,
} from './features/chat-runtime/im-routing.js';
import {
  collectMessageImages,
  createMainConversationRuntime,
  formatMessages,
} from './features/chat-runtime/main-conversation-runtime.js';
import { createMessageLoop } from './features/chat-runtime/message-loop.js';
import { createIpcRuntime } from './features/chat-runtime/ipc-runtime.js';
import { createAgentRuntimeAdapter } from './features/chat-runtime/agent-runtime-adapter.js';
import { createAgentConversationRuntime } from './features/chat-runtime/agent-conversation-runtime.js';

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

function getAgentReplyRouteJid(
  folder: string,
  chatJid: string,
  agentId?: string,
): string | undefined {
  return resolveReplyRouteJid(
    activeImReplyRoutes,
    folder,
    chatJid,
    agentId,
    (jid) => imManager.isChannelAvailableForJid(jid),
  );
}

// Track consecutive IM send failures per JID for auto-unbind
const imSendFailCounts = new Map<string, number>();

// Groups whose pending messages were recovered after a restart.
// processGroupMessages injects recent conversation history for these groups
// so the fresh session has context despite the session being cleared.
const recoveryGroups = new Set<string>();

// Track consecutive IM health check failures per JID for safe auto-unbind
const imHealthCheckFailCounts = new Map<string, number>();
let bootstrap: ReturnType<typeof createBootstrapRuntime>;
let ipcRuntime: ReturnType<typeof createIpcRuntime>;
let agentConversationRuntime: ReturnType<typeof createAgentConversationRuntime>;

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
} = createBootstrapStateRuntime({
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
} = createAgentRuntimeAdapter({
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
  getAgentReplyRouteJid,
});

agentConversationRuntime = createAgentConversationRuntime({
  assistantName: ASSISTANT_NAME,
  registeredGroups,
  lastAgentTimestamp,
  advanceCursors,
  formatMessages,
  collectMessageImages,
  queue,
  getIpcRuntime: () => ipcRuntime,
  getAvailableGroups,
  resolveEffectiveGroup,
  resolveOwnerHomeFolder,
  extractLocalImImagePaths,
  sendImWithRetry,
  sendImWithFailTracking,
  writeUsageRecords,
  getAgentReplyRouteJid,
  getEffectiveRuntime,
  sendSystemMessage,
  broadcastStreamEvent,
  broadcastNewMessage,
  broadcastAgentStatus,
  imManager,
  getChannelType,
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
  getAgentReplyRouteJid,
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

bootstrap = createBootstrapRuntime({
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
  return agentConversationRuntime.processAgentConversation(chatJid, agentId);
}

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TIMEZONE,
} from '../../app/config.js';
import {
  runContainerAgent,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../execution/container-runner.js';
import {
  createTask,
  deleteTask,
  ensureChatExists,
  getAllTasks,
  getMessagesSince,
  getTaskById,
  isGroupShared,
  setSession,
  storeMessageDirect,
  updateAgentStatus,
  listActiveConversationAgents,
  getRuntimeSession,
  getGroupsByOwner,
  insertUsageRecord,
  updateTask,
} from '../../db.js';
// feishu.js deprecated exports are no longer needed; imManager handles all connections
import { imManager } from '../im/im-manager.js';
import { getChannelType } from '../im/im-channel.js';
import { hasActiveStreamingSession } from '../im/channels/feishu/streaming-card/index.js';
import { getSystemSettings } from '../../runtime-config.js';
import { logger } from '../../app/logger.js';
import {
  broadcastToWebClients,
  broadcastNewMessage,
  broadcastTyping,
  broadcastStreamEvent,
  broadcastAgentStatus,
  getActiveStreamingTexts,
} from '../../web.js';
import {
  installSkillForUser,
  deleteSkillForUser,
} from '../skills/routes/skills.js';
import { clearPersistedRuntimeStateForRecovery } from './runtime-state-cleanup.js';
import { EMPTY_CURSOR, isCursorAfter } from './recovery.js';
import { createRuntimeBootstrapSupport } from './runtime-bootstrap-support.js';
import { createRuntimeInteractionSupport } from './runtime-interaction-support.js';
import { createRuntimeExecutionSupport } from './runtime-execution-support.js';
import { createRuntimeProcessState } from './runtime-process-state.js';
import { createRuntimeStateSupport } from './runtime-support.js';
import {
  collectMessageImages,
  formatMessages,
} from './main-conversation-runtime.js';

const OOM_EXIT_RE = /code 137/;
const STUCK_RUNNER_CHECK_INTERVAL_POLLS = 15;
const STUCK_RUNNER_IDLE_MS = 6 * 60 * 1000;
const OOM_AUTO_RESET_THRESHOLD = 2;

const {
  sessions,
  registeredGroups,
  lastAgentTimestamp,
  lastCommittedCursor,
  shutdownSavedJids,
  queue,
  terminalWarmupInFlight,
  consecutiveOomExits,
  getGlobalMessageCursor,
  setGlobalMessageCursor,
  isShuttingDown,
  setShuttingDown,
  getStuckRunnerCheckCounter,
  resetStuckRunnerCheckCounter,
  incrementStuckRunnerCheckCounter,
} = createRuntimeProcessState();

let bootstrap: ReturnType<typeof createRuntimeBootstrapSupport>;
let ipcRuntime: ReturnType<typeof createRuntimeExecutionSupport>['ipcRuntime'];
let agentConversationRuntime: ReturnType<
  typeof createRuntimeExecutionSupport
>['agentConversationRuntime'];

const {
  setCursors,
  advanceCursors,
  getAvailableGroups,
  loadState,
  migrateDataDirectories,
  migrateSystemIMToPerUser,
  registerGroup,
  saveState,
  syncGroupMetadata,
  saveInterruptedStreamingMessages,
  recoverStreamingBuffer,
  startStreamingBuffer,
  stopStreamingBuffer,
} = createRuntimeStateSupport({
  dataDir: DATA_DIR,
  assistantName: ASSISTANT_NAME,
  getGlobalMessageCursor,
  setGlobalMessageCursor,
  lastAgentTimestamp,
  lastCommittedCursor,
  sessions,
  registeredGroups,
  consecutiveOomExits,
  shutdownSavedJids,
  logger,
  getActiveStreamingTexts,
  ensureChatExists,
  storeMessageDirect,
});

const stateSupport = {
  setCursors,
  getAvailableGroups,
  loadState,
  migrateDataDirectories,
  migrateSystemIMToPerUser,
  registerGroup,
  saveState,
  syncGroupMetadata,
  saveInterruptedStreamingMessages,
  recoverStreamingBuffer,
  startStreamingBuffer,
  stopStreamingBuffer,
};

const processAgentConversation = async (
  chatJid: string,
  agentId: string,
): Promise<void> =>
  agentConversationRuntime.processAgentConversation(chatJid, agentId);

const {
  activeRouteUpdaters,
  activeImReplyRoutes,
  imSendFailCounts,
  recoveryGroups,
  imHealthCheckFailCounts,
  getAgentReplyRouteJid,
  handleCommand,
  handleSpawnCommand,
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
  recoverStuckPendingGroups,
  recoverPendingMessages,
  recoverConversationAgents,
} = createRuntimeInteractionSupport({
  queue,
  registerGroup,
  registeredGroups,
  sessions,
  lastAgentTimestamp,
  lastCommittedCursor,
  setCursors,
  processAgentConversation,
  formatMessages,
  collectMessageImages,
  emptyCursor: EMPTY_CURSOR,
  imManager,
  logger,
  idleThresholdMs: STUCK_RUNNER_IDLE_MS,
  getMessagesSince,
  clearPersistedRuntimeStateForRecovery,
  assistantName: ASSISTANT_NAME,
  listActiveConversationAgents,
  updateAgentStatus,
  broadcastAgentStatus,
  getRuntimeSession,
  storeMessageDirect,
  broadcastNewMessage,
});

const interactionSupport = {
  activeRouteUpdaters,
  activeImReplyRoutes,
  recoveryGroups,
  imHealthCheckFailCounts,
  getAgentReplyRouteJid,
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
  recoverStuckPendingGroups,
  recoverPendingMessages,
  recoverConversationAgents,
  handleCommand,
  handleSpawnCommand,
};

const {
  runAgent,
  getEffectiveRuntime,
  sendBillingDeniedMessage,
  setTyping,
  sendMessage,
  sendSystemMessage,
  writeUsageRecords,
  ensureTerminalContainerStarted,
  startMessageLoop,
  processGroupMessages,
  agentConversationRuntime: createdAgentConversationRuntime,
  ipcRuntime: createdIpcRuntime,
} = createRuntimeExecutionSupport({
  assistantName: ASSISTANT_NAME,
  queue,
  registeredGroups,
  sessions,
  terminalWarmupInFlight,
  getAvailableGroups: stateSupport.getAvailableGroups,
  getAllTasks,
  activeImReplyRoutes: interactionSupport.activeImReplyRoutes,
  hasActiveStreamingSession,
  imManager,
  getChannelType,
  ensureChatExists,
  storeMessageDirect,
  broadcastNewMessage,
  broadcastToWebClients,
  broadcastTyping,
  broadcastStreamEvent,
  broadcastAgentStatus,
  extractLocalImImagePaths: interactionSupport.extractLocalImImagePaths,
  resolveEffectiveFolder: interactionSupport.resolveEffectiveFolder,
  resolveOwnerHomeFolder: interactionSupport.resolveOwnerHomeFolder,
  resolveEffectiveGroup: interactionSupport.resolveEffectiveGroup,
  getSystemSettings,
  insertUsageRecord,
  setSession,
  runHostAgent,
  runContainerAgent,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  logger,
  pollInterval: POLL_INTERVAL,
  emptyCursor: EMPTY_CURSOR,
  lastAgentTimestamp,
  recoveryGroups: interactionSupport.recoveryGroups,
  getGlobalMessageCursor,
  setGlobalMessageCursor,
  saveState: stateSupport.saveState,
  setCursors: stateSupport.setCursors,
  getStuckRunnerCheckCounter,
  resetStuckRunnerCheckCounter,
  incrementStuckRunnerCheckCounter,
  stuckRunnerCheckIntervalPolls: STUCK_RUNNER_CHECK_INTERVAL_POLLS,
  recoverStuckPendingGroups: interactionSupport.recoverStuckPendingGroups,
  isShuttingDown,
  formatMessages,
  collectMessageImages,
  isGroupShared,
  activeRouteUpdaters: interactionSupport.activeRouteUpdaters,
  shutdownSavedJids,
  consecutiveOomExits,
  oomExitRe: OOM_EXIT_RE,
  oomAutoResetThreshold: OOM_AUTO_RESET_THRESHOLD,
  setActiveImReplyRoute: interactionSupport.setActiveImReplyRoute,
  clearActiveImReplyRoute: interactionSupport.clearActiveImReplyRoute,
  advanceCursors,
  sendImWithRetry: interactionSupport.sendImWithRetry,
  sendImWithFailTracking: interactionSupport.sendImWithFailTracking,
  getAgentReplyRouteJid: interactionSupport.getAgentReplyRouteJid,
  dataDir: DATA_DIR,
  groupsDir: GROUPS_DIR,
  mainGroupFolder: MAIN_GROUP_FOLDER,
  timezone: TIMEZONE,
  getShuttingDown: isShuttingDown,
  retryImOperation: interactionSupport.retryImOperation,
  getGroupsByOwner,
  syncGroupMetadata: stateSupport.syncGroupMetadata,
  registerGroup: stateSupport.registerGroup,
  installSkillForUser,
  deleteSkillForUser,
  sendImage: (jid, imageBuffer, mimeType, caption, fileName) =>
    imManager.sendImage(jid, imageBuffer, mimeType, caption, fileName),
  sendFile: (jid, filePath, fileName) =>
    imManager.sendFile(jid, filePath, fileName),
  createTask,
  deleteTask,
  getTaskById,
  updateTask,
});

agentConversationRuntime = createdAgentConversationRuntime;
ipcRuntime = createdIpcRuntime;

const executionSupport = {
  ensureTerminalContainerStarted,
  processGroupMessages,
  setTyping,
  startMessageLoop,
  sendMessage,
  sendSystemMessage,
};

bootstrap = createRuntimeBootstrapSupport({
  processState: {
    queue,
    lastAgentTimestamp,
    registeredGroups,
    sessions,
    getGlobalMessageCursor,
    setGlobalMessageCursor,
    setShuttingDown,
  },
  stateSupport,
  interactionSupport,
  executionSupport,
  ipcRuntime,
  helpers: {
    formatMessages,
    isCursorAfter,
    processAgentConversation,
  },
});
export async function startRuntime(): Promise<void> {
  await bootstrap.start();
}

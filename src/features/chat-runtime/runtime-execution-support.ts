import { createAgentRuntimeAdapter } from './agent-runtime-adapter.js';
import { createAgentConversationRuntime } from './agent-conversation-runtime.js';
import { createIpcRuntime } from './ipc-runtime.js';
import { createMainConversationRuntime } from './main-conversation-runtime.js';
import { createMessageLoop } from './message-loop.js';
import type {
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
} from '../../shared/types.js';
import type { GroupQueue } from './group-queue.js';

interface RuntimeExecutionSupportDeps {
  assistantName: string;
  queue: GroupQueue;
  registeredGroups: Record<string, RegisteredGroup>;
  sessions: Record<string, RuntimeSessionRecord>;
  terminalWarmupInFlight: Set<string>;
  getAvailableGroups: () => any[];
  getAllTasks: () => any[];
  activeImReplyRoutes: Map<string, string | null>;
  hasActiveStreamingSession: (jid: string) => boolean;
  imManager: any;
  getChannelType: (jid: string) => string | null;
  ensureChatExists: (jid: string) => void;
  storeMessageDirect: (...args: any[]) => string;
  broadcastNewMessage: (...args: any[]) => void;
  broadcastToWebClients: (jid: string, text: string) => void;
  broadcastTyping: (jid: string, isTyping: boolean) => void;
  broadcastStreamEvent: (...args: any[]) => void;
  broadcastAgentStatus: (...args: any[]) => void;
  extractLocalImImagePaths: (text: string, groupFolder?: string) => string[];
  resolveEffectiveFolder: (chatJid: string) => string | undefined;
  resolveOwnerHomeFolder: (group: RegisteredGroup) => string | undefined;
  resolveEffectiveGroup: (group: RegisteredGroup) => {
    effectiveGroup: RegisteredGroup;
    isHome: boolean;
  };
  getSystemSettings: () => any;
  insertUsageRecord: (record: any) => void;
  setSession: (
    groupFolder: string,
    sessionId: string,
    agentId?: string,
  ) => void;
  runHostAgent: any;
  runContainerAgent: any;
  writeTasksSnapshot: any;
  writeGroupsSnapshot: any;
  logger: any;
  pollInterval: number;
  emptyCursor: MessageCursor;
  lastAgentTimestamp: Record<string, MessageCursor>;
  recoveryGroups: Set<string>;
  getGlobalMessageCursor: () => MessageCursor;
  setGlobalMessageCursor: (cursor: MessageCursor) => void;
  saveState: () => void;
  setCursors: (jid: string, cursor: MessageCursor) => void;
  getStuckRunnerCheckCounter: () => number;
  resetStuckRunnerCheckCounter: () => void;
  incrementStuckRunnerCheckCounter: () => number;
  stuckRunnerCheckIntervalPolls: number;
  recoverStuckPendingGroups: () => void;
  isShuttingDown: () => boolean;
  formatMessages: (...args: any[]) => string;
  collectMessageImages: (...args: any[]) => Array<{
    data: string;
    mimeType: string;
  }>;
  isGroupShared: (folder: string) => boolean;
  activeRouteUpdaters: Map<string, (sourceJid: string | null) => void>;
  shutdownSavedJids: Set<string>;
  consecutiveOomExits: Record<string, number>;
  oomExitRe: RegExp;
  oomAutoResetThreshold: number;
  setActiveImReplyRoute: (folder: string, sourceJid: string | null) => void;
  clearActiveImReplyRoute: (folder: string) => void;
  advanceCursors: (jid: string, candidate: MessageCursor) => void;
  sendImWithRetry: (
    imJid: string,
    text: string,
    localImagePaths: string[],
  ) => Promise<boolean>;
  sendImWithFailTracking: (...args: any[]) => void;
  getAgentReplyRouteJid: (
    folder: string,
    chatJid: string,
    agentId?: string,
  ) => string | undefined;
  dataDir: string;
  groupsDir: string;
  mainGroupFolder: string;
  timezone: string;
  getShuttingDown: () => boolean;
  retryImOperation: (...args: any[]) => Promise<any>;
  getGroupsByOwner: (...args: any[]) => any;
  syncGroupMetadata: (...args: any[]) => Promise<void>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  installSkillForUser: (...args: any[]) => Promise<any>;
  deleteSkillForUser: (...args: any[]) => any;
  sendImage: (...args: any[]) => Promise<any>;
  sendFile: (...args: any[]) => Promise<any>;
  createTask: (...args: any[]) => any;
  deleteTask: (...args: any[]) => any;
  getTaskById: (...args: any[]) => any;
  updateTask: (...args: any[]) => any;
}

export function createRuntimeExecutionSupport(
  deps: RuntimeExecutionSupportDeps,
) {
  let ipcRuntime: ReturnType<typeof createIpcRuntime>;

  const agentRuntime = createAgentRuntimeAdapter({
    assistantName: deps.assistantName,
    queue: deps.queue,
    registeredGroups: deps.registeredGroups,
    sessions: deps.sessions,
    terminalWarmupInFlight: deps.terminalWarmupInFlight,
    getIpcRuntime: () => ipcRuntime,
    getAvailableGroups: deps.getAvailableGroups,
    getAllTasks: deps.getAllTasks,
    activeImReplyRoutes: deps.activeImReplyRoutes,
    hasActiveStreamingSession: deps.hasActiveStreamingSession,
    imManager: deps.imManager,
    getChannelType: deps.getChannelType,
    ensureChatExists: deps.ensureChatExists,
    storeMessageDirect: deps.storeMessageDirect,
    broadcastNewMessage: deps.broadcastNewMessage,
    broadcastToWebClients: deps.broadcastToWebClients,
    broadcastTyping: deps.broadcastTyping,
    broadcastStreamEvent: deps.broadcastStreamEvent,
    extractLocalImImagePaths: deps.extractLocalImImagePaths,
    resolveEffectiveFolder: deps.resolveEffectiveFolder,
    resolveOwnerHomeFolder: deps.resolveOwnerHomeFolder,
    getSystemSettings: deps.getSystemSettings,
    insertUsageRecord: deps.insertUsageRecord,
    setSession: deps.setSession,
    runHostAgent: deps.runHostAgent,
    runContainerAgent: deps.runContainerAgent,
    writeTasksSnapshot: deps.writeTasksSnapshot,
    writeGroupsSnapshot: deps.writeGroupsSnapshot,
    logger: deps.logger,
  });

  const {
    runAgent,
    getEffectiveRuntime,
    sendBillingDeniedMessage,
    setTyping,
    sendMessage,
    sendSystemMessage,
    writeUsageRecords,
    ensureTerminalContainerStarted,
  } = agentRuntime;

  const { startMessageLoop } = createMessageLoop({
    queue: deps.queue,
    pollInterval: deps.pollInterval,
    emptyCursor: deps.emptyCursor,
    registeredGroups: deps.registeredGroups,
    lastAgentTimestamp: deps.lastAgentTimestamp,
    recoveryGroups: deps.recoveryGroups,
    getGlobalMessageCursor: deps.getGlobalMessageCursor,
    setGlobalMessageCursor: deps.setGlobalMessageCursor,
    saveState: deps.saveState,
    setCursors: deps.setCursors,
    getStuckRunnerCheckCounter: deps.getStuckRunnerCheckCounter,
    resetStuckRunnerCheckCounter: deps.resetStuckRunnerCheckCounter,
    incrementStuckRunnerCheckCounter: deps.incrementStuckRunnerCheckCounter,
    stuckRunnerCheckIntervalPolls: deps.stuckRunnerCheckIntervalPolls,
    recoverStuckPendingGroups: deps.recoverStuckPendingGroups,
    isShuttingDown: deps.isShuttingDown,
    formatMessages: deps.formatMessages,
    collectMessageImages: deps.collectMessageImages,
    isGroupShared: deps.isGroupShared,
    sendBillingDeniedMessage,
    imManager: deps.imManager,
    activeRouteUpdaters: deps.activeRouteUpdaters,
  });

  const { processGroupMessages } = createMainConversationRuntime({
    registeredGroups: deps.registeredGroups,
    sessions: deps.sessions,
    lastAgentTimestamp: deps.lastAgentTimestamp,
    recoveryGroups: deps.recoveryGroups,
    activeRouteUpdaters: deps.activeRouteUpdaters,
    shutdownSavedJids: deps.shutdownSavedJids,
    consecutiveOomExits: deps.consecutiveOomExits,
    oomExitRe: deps.oomExitRe,
    oomAutoResetThreshold: deps.oomAutoResetThreshold,
    resolveEffectiveGroup: deps.resolveEffectiveGroup,
    setActiveImReplyRoute: deps.setActiveImReplyRoute,
    clearActiveImReplyRoute: deps.clearActiveImReplyRoute,
    advanceCursors: deps.advanceCursors,
    isGroupShared: deps.isGroupShared,
    closeStdin: (chatJid) => deps.queue.closeStdin(chatJid),
    runAgent,
    getEffectiveRuntime,
    sendBillingDeniedMessage,
    setTyping,
    sendMessage,
    sendSystemMessage,
    extractLocalImImagePaths: deps.extractLocalImImagePaths,
    sendImWithFailTracking: deps.sendImWithFailTracking,
    writeUsageRecords,
    getAgentReplyRouteJid: deps.getAgentReplyRouteJid,
  });

  const agentConversationRuntime = createAgentConversationRuntime({
    assistantName: deps.assistantName,
    registeredGroups: deps.registeredGroups,
    lastAgentTimestamp: deps.lastAgentTimestamp,
    advanceCursors: deps.advanceCursors,
    formatMessages: deps.formatMessages,
    collectMessageImages: deps.collectMessageImages,
    queue: deps.queue,
    getIpcRuntime: () => ipcRuntime,
    getAvailableGroups: deps.getAvailableGroups,
    resolveEffectiveGroup: deps.resolveEffectiveGroup,
    resolveOwnerHomeFolder: deps.resolveOwnerHomeFolder,
    extractLocalImImagePaths: deps.extractLocalImImagePaths,
    sendImWithRetry: deps.sendImWithRetry,
    sendImWithFailTracking: deps.sendImWithFailTracking,
    writeUsageRecords,
    getAgentReplyRouteJid: deps.getAgentReplyRouteJid,
    getEffectiveRuntime,
    sendSystemMessage,
    broadcastStreamEvent: deps.broadcastStreamEvent,
    broadcastNewMessage: deps.broadcastNewMessage,
    broadcastAgentStatus: deps.broadcastAgentStatus,
    imManager: deps.imManager,
    getChannelType: deps.getChannelType,
  });

  ipcRuntime = createIpcRuntime({
    dataDir: deps.dataDir,
    groupsDir: deps.groupsDir,
    mainGroupFolder: deps.mainGroupFolder,
    timezone: deps.timezone,
    assistantName: deps.assistantName,
    getRegisteredGroups: () => deps.registeredGroups,
    getShuttingDown: deps.getShuttingDown,
    getActiveImReplyRoute: (folder) => deps.activeImReplyRoutes.get(folder),
    getAgentReplyRouteJid: deps.getAgentReplyRouteJid,
    sendMessage,
    ensureChatExists: deps.ensureChatExists,
    storeMessageDirect: deps.storeMessageDirect,
    broadcastNewMessage: deps.broadcastNewMessage,
    broadcastToWebClients: deps.broadcastToWebClients,
    extractLocalImImagePaths: deps.extractLocalImImagePaths,
    sendImWithFailTracking: deps.sendImWithFailTracking,
    retryImOperation: deps.retryImOperation,
    getChannelType: deps.getChannelType,
    getGroupsByOwner: deps.getGroupsByOwner,
    getConnectedChannelTypes: (userId) =>
      deps.imManager.getConnectedChannelTypes(userId),
    sendImage: deps.sendImage,
    sendFile: deps.sendFile,
    createTask: deps.createTask,
    deleteTask: deps.deleteTask,
    getAllTasks: deps.getAllTasks,
    getTaskById: deps.getTaskById,
    updateTask: deps.updateTask,
    syncGroupMetadata: deps.syncGroupMetadata,
    getAvailableGroups: deps.getAvailableGroups,
    writeGroupsSnapshot: deps.writeGroupsSnapshot,
    registerGroup: deps.registerGroup,
    installSkillForUser: deps.installSkillForUser,
    deleteSkillForUser: deps.deleteSkillForUser,
  });

  return {
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
    agentConversationRuntime,
    ipcRuntime,
  };
}

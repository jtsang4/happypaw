import { createBootstrapRuntime } from './bootstrap.js';
import type {
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
} from '../../shared/types.js';
import type { GroupQueue } from './group-queue.js';

interface RuntimeBootstrapSupportDeps {
  processState: {
    queue: GroupQueue;
    lastAgentTimestamp: Record<string, MessageCursor>;
    registeredGroups: Record<string, RegisteredGroup>;
    sessions: Record<string, RuntimeSessionRecord>;
    getGlobalMessageCursor: () => MessageCursor;
    setGlobalMessageCursor: (cursor: MessageCursor) => void;
    setShuttingDown: (value: boolean) => void;
  };
  stateSupport: {
    loadState: () => void;
    migrateDataDirectories: () => void;
    migrateSystemIMToPerUser: () => void;
    saveInterruptedStreamingMessages: () => void;
    recoverStreamingBuffer: () => void;
    saveState: () => void;
    setCursors: (jid: string, cursor: MessageCursor) => void;
    startStreamingBuffer: () => void;
    stopStreamingBuffer: () => void;
    syncGroupMetadata: (force?: boolean) => Promise<void>;
  };
  interactionSupport: {
    activeRouteUpdaters: Map<string, (sourceJid: string | null) => void>;
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
    connectUserIMChannels: (...args: any[]) => Promise<any>;
    handleCardInterrupt: (chatJid: string) => void;
    handleCommand: (chatJid: string, command: string) => Promise<string | null>;
    handleSpawnCommand: (
      chatJid: string,
      rawMessage: string,
      sourceImJid?: string,
    ) => Promise<string>;
    imHealthCheckFailCounts: Map<string, number>;
    recoverConversationAgents: () => void;
    recoverPendingMessages: () => void;
    resolveEffectiveFolder: (chatJid: string) => string | undefined;
    resolveEffectiveGroup: (group: RegisteredGroup) => {
      effectiveGroup: RegisteredGroup;
    };
    shouldProcessGroupMessage: (chatJid: string) => boolean;
    unbindImGroup: (jid: string, reason: string) => void;
  };
  executionSupport: {
    ensureTerminalContainerStarted: (chatJid: string) => boolean;
    processGroupMessages: (chatJid: string) => Promise<boolean>;
    setTyping: (jid: string, isTyping: boolean) => Promise<void>;
    startMessageLoop: () => void;
    sendMessage: (...args: any[]) => Promise<string | undefined>;
    sendSystemMessage: (jid: string, type: string, detail: string) => void;
  };
  ipcRuntime: {
    closeAll: () => void;
    startIpcWatcher: () => void;
  };
  helpers: {
    formatMessages: (...args: any[]) => string;
    isCursorAfter: (cursor: MessageCursor, current: MessageCursor) => boolean;
    processAgentConversation: (
      chatJid: string,
      agentId: string,
    ) => Promise<void>;
  };
}

export function createRuntimeBootstrapSupport(
  deps: RuntimeBootstrapSupportDeps,
) {
  const { processState, stateSupport, interactionSupport, executionSupport } =
    deps;

  return createBootstrapRuntime({
    activeRouteUpdaters: interactionSupport.activeRouteUpdaters,
    buildIsChatAuthorized: interactionSupport.buildIsChatAuthorized,
    buildOnAgentMessage: interactionSupport.buildOnAgentMessage,
    buildOnBotRemovedFromGroup: interactionSupport.buildOnBotRemovedFromGroup,
    buildOnNewChat: interactionSupport.buildOnNewChat,
    buildOnPairAttempt: interactionSupport.buildOnPairAttempt,
    buildResolveEffectiveChatJid:
      interactionSupport.buildResolveEffectiveChatJid,
    buildTelegramBotAddedHandler:
      interactionSupport.buildTelegramBotAddedHandler,
    connectUserIMChannels: interactionSupport.connectUserIMChannels,
    ensureTerminalContainerStarted:
      executionSupport.ensureTerminalContainerStarted,
    formatMessages: deps.helpers.formatMessages,
    getGlobalMessageCursor: processState.getGlobalMessageCursor,
    handleCardInterrupt: interactionSupport.handleCardInterrupt,
    handleCommand: interactionSupport.handleCommand,
    handleSpawnCommand: interactionSupport.handleSpawnCommand,
    imHealthCheckFailCounts: interactionSupport.imHealthCheckFailCounts,
    ipcRuntime: deps.ipcRuntime,
    isCursorAfter: deps.helpers.isCursorAfter,
    lastAgentTimestamp: processState.lastAgentTimestamp,
    loadState: stateSupport.loadState,
    migrateDataDirectories: stateSupport.migrateDataDirectories,
    migrateSystemIMToPerUser: stateSupport.migrateSystemIMToPerUser,
    processAgentConversation: deps.helpers.processAgentConversation,
    processGroupMessages: executionSupport.processGroupMessages,
    queue: processState.queue,
    recoverConversationAgents: interactionSupport.recoverConversationAgents,
    recoverPendingMessages: interactionSupport.recoverPendingMessages,
    recoverStreamingBuffer: stateSupport.recoverStreamingBuffer,
    registeredGroups: processState.registeredGroups,
    resolveEffectiveFolder: (chatJid) =>
      interactionSupport.resolveEffectiveFolder(chatJid) || '',
    resolveEffectiveGroup: interactionSupport.resolveEffectiveGroup,
    saveInterruptedStreamingMessages:
      stateSupport.saveInterruptedStreamingMessages,
    saveState: stateSupport.saveState,
    sessions: processState.sessions,
    setCursors: stateSupport.setCursors,
    setGlobalMessageCursor: processState.setGlobalMessageCursor,
    setShuttingDown: processState.setShuttingDown,
    setTyping: executionSupport.setTyping,
    shouldProcessGroupMessage: interactionSupport.shouldProcessGroupMessage,
    startMessageLoop: executionSupport.startMessageLoop,
    startStreamingBuffer: stateSupport.startStreamingBuffer,
    stopStreamingBuffer: stateSupport.stopStreamingBuffer,
    syncGroupMetadata: stateSupport.syncGroupMetadata,
    unbindImGroup: interactionSupport.unbindImGroup,
    sendMessage: executionSupport.sendMessage,
    sendSystemMessage: executionSupport.sendSystemMessage,
  });
}

import { createBootstrapStateRuntime } from './bootstrap-state.js';
import {
  createCursorStateHelpers,
  createStreamingBufferManager,
  recoverConversationAgents as recoverConversationAgentsHelper,
  recoverPendingMessages as recoverPendingMessagesHelper,
  recoverStuckPendingGroups as recoverStuckPendingGroupsHelper,
} from './recovery.js';
import type { GroupQueue } from './group-queue.js';
import type {
  MessageCursor,
  MessageFinalizationReason,
  MessageSourceKind,
  RegisteredGroup,
  RuntimeSessionRecord,
} from '../../shared/types.js';

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

interface RuntimeStateSupportDeps {
  dataDir: string;
  assistantName: string;
  logger: LoggerLike;
  shutdownSavedJids: Set<string>;
  getActiveStreamingTexts: () => Map<string, string>;
  ensureChatExists: (jid: string) => void;
  storeMessageDirect: (
    id: string,
    chatJid: string,
    sender: string,
    senderName: string,
    content: string,
    timestamp: string,
    isFromMe: boolean,
    extra?: {
      attachments?: string;
      tokenUsage?: string;
      sourceJid?: string;
      meta?: {
        turnId?: string | null;
        sessionId?: string | null;
        sdkMessageUuid?: string | null;
        sourceKind?: MessageSourceKind | null;
        finalizationReason?: MessageFinalizationReason | null;
      };
    },
  ) => string | number;
  getGlobalMessageCursor: () => MessageCursor;
  setGlobalMessageCursor: (cursor: MessageCursor) => void;
  lastAgentTimestamp: Record<string, MessageCursor>;
  lastCommittedCursor: Record<string, MessageCursor>;
  sessions: Record<string, RuntimeSessionRecord>;
  registeredGroups: Record<string, RegisteredGroup>;
  consecutiveOomExits: Record<string, number>;
}

export function createRuntimeStateSupport(deps: RuntimeStateSupportDeps) {
  const {
    getAvailableGroups,
    loadState,
    migrateDataDirectories,
    migrateSystemIMToPerUser,
    registerGroup,
    saveState,
    syncGroupMetadata,
  } = createBootstrapStateRuntime({
    getGlobalMessageCursor: deps.getGlobalMessageCursor,
    setGlobalMessageCursor: deps.setGlobalMessageCursor,
    lastAgentTimestamp: deps.lastAgentTimestamp,
    lastCommittedCursor: deps.lastCommittedCursor,
    sessions: deps.sessions,
    registeredGroups: deps.registeredGroups,
    consecutiveOomExits: deps.consecutiveOomExits,
  });

  const { setCursors, advanceCursors } = createCursorStateHelpers({
    getLastAgentTimestamp: () => deps.lastAgentTimestamp,
    getLastCommittedCursor: () => deps.lastCommittedCursor,
    saveState: () => saveState(),
  });

  const {
    saveInterruptedStreamingMessages,
    recoverStreamingBuffer,
    startStreamingBuffer,
    stopStreamingBuffer,
  } = createStreamingBufferManager({
    dataDir: deps.dataDir,
    assistantName: deps.assistantName,
    shutdownSavedJids: deps.shutdownSavedJids,
    logger: deps.logger,
    getActiveStreamingTexts: deps.getActiveStreamingTexts,
    ensureChatExists: deps.ensureChatExists,
    storeMessageDirect: deps.storeMessageDirect,
  });

  return {
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
  };
}

interface RuntimeRecoveryHandlersDeps {
  queue: GroupQueue;
  logger: LoggerLike;
  idleThresholdMs: number;
  recoveryGroups: Set<string>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getLastCommittedCursor: () => Record<string, MessageCursor>;
  getSessions: () => Record<string, RuntimeSessionRecord>;
  getMessagesSince: (...args: any[]) => any;
  clearPersistedRuntimeStateForRecovery: (
    sessions: Record<string, RuntimeSessionRecord>,
    groupFolder: string,
    agentId?: string,
  ) => void;
  assistantName: string;
  emptyCursor: MessageCursor;
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  listActiveConversationAgents: (...args: any[]) => any;
  updateAgentStatus: (...args: any[]) => any;
  broadcastAgentStatus: (...args: any[]) => void;
  getRuntimeSession: (...args: any[]) => any;
  storeMessageDirect: (...args: any[]) => any;
  broadcastNewMessage: (...args: any[]) => void;
  processAgentConversation: (chatJid: string, agentId: string) => Promise<void>;
}

export function createRuntimeRecoveryHandlers(
  deps: RuntimeRecoveryHandlersDeps,
) {
  function recoverStuckPendingGroups(): void {
    recoverStuckPendingGroupsHelper({
      queue: deps.queue,
      logger: deps.logger,
      idleThresholdMs: deps.idleThresholdMs,
    });
  }

  function recoverPendingMessages(): void {
    recoverPendingMessagesHelper({
      logger: deps.logger,
      queue: deps.queue,
      recoveryGroups: deps.recoveryGroups,
      getRegisteredGroups: deps.getRegisteredGroups,
      getLastCommittedCursor: deps.getLastCommittedCursor,
      getSessions: deps.getSessions,
      getMessagesSince: deps.getMessagesSince,
      clearPersistedRuntimeStateForRecovery:
        deps.clearPersistedRuntimeStateForRecovery,
    });
  }

  function recoverConversationAgents(): void {
    recoverConversationAgentsHelper({
      logger: deps.logger,
      queue: deps.queue,
      assistantName: deps.assistantName,
      emptyCursor: deps.emptyCursor,
      getLastAgentTimestamp: deps.getLastAgentTimestamp,
      getSessions: deps.getSessions,
      listActiveConversationAgents: deps.listActiveConversationAgents,
      updateAgentStatus: deps.updateAgentStatus,
      broadcastAgentStatus: deps.broadcastAgentStatus,
      getMessagesSince: deps.getMessagesSince,
      getRuntimeSession: deps.getRuntimeSession,
      clearPersistedRuntimeStateForRecovery:
        deps.clearPersistedRuntimeStateForRecovery,
      storeMessageDirect: deps.storeMessageDirect,
      broadcastNewMessage: deps.broadcastNewMessage,
      processAgentConversation: deps.processAgentConversation,
    });
  }

  return {
    recoverStuckPendingGroups,
    recoverPendingMessages,
    recoverConversationAgents,
  };
}

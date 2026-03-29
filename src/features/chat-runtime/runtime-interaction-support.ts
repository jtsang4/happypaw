import { createSlashCommandHandlers } from './slash-commands.js';
import { createImRoutingHelpers, resolveReplyRouteJid } from './im-routing.js';
import { createRuntimeRecoveryHandlers } from './runtime-support.js';
import type {
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
} from '../../shared/types.js';

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

interface RuntimeInteractionSupportDeps {
  queue: any;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: Record<string, RegisteredGroup>;
  sessions: Record<string, RuntimeSessionRecord>;
  lastAgentTimestamp: Record<string, MessageCursor>;
  lastCommittedCursor: Record<string, MessageCursor>;
  setCursors: (jid: string, cursor: MessageCursor) => void;
  processAgentConversation: (chatJid: string, agentId: string) => Promise<void>;
  formatMessages: (...args: any[]) => string;
  collectMessageImages: (
    ...args: any[]
  ) => Array<{ data: string; mimeType: string }>;
  emptyCursor: MessageCursor;
  imManager: {
    isChannelAvailableForJid: (jid: string) => boolean;
  };
  logger: LoggerLike;
  idleThresholdMs: number;
  getMessagesSince: (...args: any[]) => any;
  clearPersistedRuntimeStateForRecovery: (
    sessions: Record<string, RuntimeSessionRecord>,
    groupFolder: string,
    agentId?: string,
  ) => void;
  assistantName: string;
  listActiveConversationAgents: (...args: any[]) => any;
  updateAgentStatus: (...args: any[]) => any;
  broadcastAgentStatus: (...args: any[]) => void;
  getRuntimeSession: (...args: any[]) => any;
  storeMessageDirect: (...args: any[]) => any;
  broadcastNewMessage: (...args: any[]) => void;
}

export function createRuntimeInteractionSupport(
  deps: RuntimeInteractionSupportDeps,
) {
  const activeRouteUpdaters = new Map<
    string,
    (sourceJid: string | null) => void
  >();
  const activeImReplyRoutes = new Map<string, string | null>();
  const imSendFailCounts = new Map<string, number>();
  const recoveryGroups = new Set<string>();
  const imHealthCheckFailCounts = new Map<string, number>();

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
      (jid) => deps.imManager.isChannelAvailableForJid(jid),
    );
  }

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

  const imRouting = createImRoutingHelpers({
    queue: deps.queue,
    registerGroup: deps.registerGroup,
    registeredGroups: deps.registeredGroups,
    imSendFailCounts,
    imHealthCheckFailCounts,
    lastAgentTimestamp: deps.lastAgentTimestamp,
    activeImReplyRoutes,
    activeRouteUpdaters,
    handleCommand: (chatJid, command) => handleCommand(chatJid, command),
    processAgentConversation: deps.processAgentConversation,
    formatMessages: deps.formatMessages,
    collectMessageImages: deps.collectMessageImages,
    emptyCursor: deps.emptyCursor,
  });

  ({ handleCommand, handleSpawnCommand } = createSlashCommandHandlers({
    queue: deps.queue,
    sessions: deps.sessions,
    registeredGroups: deps.registeredGroups,
    imSendFailCounts,
    imHealthCheckFailCounts,
    setCursors: deps.setCursors,
    registerGroup: deps.registerGroup,
    unbindImGroup: imRouting.unbindImGroup,
    resolveEffectiveGroup: imRouting.resolveEffectiveGroup,
    processAgentConversation: deps.processAgentConversation,
  }));

  const recoveryHandlers = createRuntimeRecoveryHandlers({
    queue: deps.queue,
    logger: deps.logger,
    idleThresholdMs: deps.idleThresholdMs,
    recoveryGroups,
    getRegisteredGroups: () => deps.registeredGroups,
    getLastCommittedCursor: () => deps.lastCommittedCursor,
    getSessions: () => deps.sessions,
    getMessagesSince: deps.getMessagesSince,
    clearPersistedRuntimeStateForRecovery:
      deps.clearPersistedRuntimeStateForRecovery,
    assistantName: deps.assistantName,
    emptyCursor: deps.emptyCursor,
    getLastAgentTimestamp: () => deps.lastAgentTimestamp,
    listActiveConversationAgents: deps.listActiveConversationAgents,
    updateAgentStatus: deps.updateAgentStatus,
    broadcastAgentStatus: deps.broadcastAgentStatus,
    getRuntimeSession: deps.getRuntimeSession,
    storeMessageDirect: deps.storeMessageDirect,
    broadcastNewMessage: deps.broadcastNewMessage,
    processAgentConversation: deps.processAgentConversation,
  });

  return {
    activeRouteUpdaters,
    activeImReplyRoutes,
    imSendFailCounts,
    recoveryGroups,
    imHealthCheckFailCounts,
    getAgentReplyRouteJid,
    handleCommand,
    handleSpawnCommand,
    ...imRouting,
    ...recoveryHandlers,
  };
}

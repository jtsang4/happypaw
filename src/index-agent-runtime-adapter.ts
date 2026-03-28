import type { ChildProcess } from 'child_process';
import crypto from 'crypto';

import type {
  AvailableGroup,
  ContainerInput,
  ContainerOutput,
} from './container-runner.js';
import { MAIN_GROUP_FOLDER } from './config.js';
import type { GroupQueue } from './group-queue.js';
import { logger as defaultLogger } from './logger.js';
import type {
  RegisteredGroup,
  RuntimeSessionRecord,
  RuntimeType,
} from './types.js';
import { stripAgentInternalTags } from './utils.js';

export interface SendMessageOptions {
  /** Whether to forward the reply to the IM channel (Feishu/Telegram). Defaults to true for IM JIDs. */
  sendToIM?: boolean;
  /** Pre-computed local image paths to attach to IM messages. Avoids redundant filesystem scans. */
  localImagePaths?: string[];
  /** Message source identifier (e.g. 'scheduled_task') for frontend routing. */
  source?: string;
  /** Metadata used to preserve Claude SDK turn semantics for persisted messages. */
  messageMeta?: {
    turnId?: string;
    sessionId?: string;
    sdkMessageUuid?: string;
    sourceKind?:
      | 'sdk_final'
      | 'sdk_send_message'
      | 'interrupt_partial'
      | 'overflow_partial'
      | 'compact_partial'
      | 'legacy'
      | 'auto_continue';
    finalizationReason?: 'completed' | 'interrupted' | 'error';
  };
}

export interface UsageRecordPayload {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
  modelUsage?: Record<
    string,
    { inputTokens: number; outputTokens: number; costUSD: number }
  >;
}

export type RunAgentFn = (
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  turnId?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  images?: Array<{ data: string; mimeType?: string }>,
) => Promise<{ status: 'success' | 'error' | 'closed'; error?: string }>;

interface AgentRuntimeAdapterDeps {
  assistantName: string;
  queue: GroupQueue;
  registeredGroups: Record<string, RegisteredGroup>;
  sessions: Record<string, RuntimeSessionRecord>;
  terminalWarmupInFlight: Set<string>;
  getIpcRuntime: () => {
    watchGroup: (folder: string) => void;
    unwatchGroup: (folder: string) => void;
  };
  getAvailableGroups: () => AvailableGroup[];
  getAllTasks: () => Array<{
    id: string;
    group_folder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>;
  activeImReplyRoutes: Map<string, string | null>;
  hasActiveStreamingSession: (jid: string) => boolean;
  imManager: {
    setTyping: (jid: string, isTyping: boolean) => Promise<void>;
    sendMessage: (
      jid: string,
      text: string,
      localImagePaths?: string[],
    ) => Promise<void>;
  };
  getChannelType: (jid: string) => string | null;
  ensureChatExists: (jid: string) => void;
  storeMessageDirect: (...args: any[]) => string;
  broadcastNewMessage: (
    jid: string,
    message: any,
    agentId?: string,
    source?: string,
  ) => void;
  broadcastToWebClients: (jid: string, text: string) => void;
  broadcastTyping: (jid: string, isTyping: boolean) => void;
  broadcastStreamEvent: (jid: string, event: any, agentId?: string) => void;
  extractLocalImImagePaths: (text: string, groupFolder?: string) => string[];
  resolveEffectiveFolder: (chatJid: string) => string | undefined;
  resolveOwnerHomeFolder: (group: RegisteredGroup) => string | undefined;
  getSystemSettings: () => {
    defaultRuntime: RuntimeType;
    idleTimeout: number;
  };
  insertUsageRecord: (record: {
    userId: string;
    groupFolder: string;
    agentId?: string;
    messageId?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
    source: 'agent';
  }) => void;
  setSession: (
    groupFolder: string,
    sessionId: string,
    agentId?: string,
  ) => void;
  runHostAgent: (
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess: (proc: ChildProcess, identifier: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    ownerHomeFolder?: string,
  ) => Promise<ContainerOutput>;
  runContainerAgent: (
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess: (proc: ChildProcess, identifier: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    ownerHomeFolder?: string,
  ) => Promise<ContainerOutput>;
  writeTasksSnapshot: (
    folder: string,
    isAdminHome: boolean,
    tasks: Array<{
      id: string;
      groupFolder: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      status: string;
      next_run: string | null;
    }>,
  ) => void;
  writeGroupsSnapshot: (
    folder: string,
    isAdminHome: boolean,
    groups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  logger?: typeof defaultLogger;
}

export function createIndexAgentRuntimeAdapter(deps: AgentRuntimeAdapterDeps): {
  writeUsageRecords: (opts: {
    userId: string;
    groupFolder: string;
    messageId?: string;
    agentId?: string;
    usage: UsageRecordPayload;
  }) => void;
  sendSystemMessage: (jid: string, type: string, detail: string) => void;
  sendBillingDeniedMessage: (jid: string, content: string) => string;
  getEffectiveRuntime: (group: RegisteredGroup) => RuntimeType;
  setTyping: (jid: string, isTyping: boolean) => Promise<void>;
  sendMessage: (
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ) => Promise<string | undefined>;
  runAgent: RunAgentFn;
  ensureTerminalContainerStarted: (chatJid: string) => boolean;
} {
  const log = deps.logger ?? defaultLogger;

  function writeUsageRecords(opts: {
    userId: string;
    groupFolder: string;
    messageId?: string;
    agentId?: string;
    usage: UsageRecordPayload;
  }): void {
    const { userId, groupFolder, messageId, agentId, usage } = opts;
    if (usage.modelUsage) {
      const models = Object.entries(usage.modelUsage);
      let cacheReadAssigned = false;
      for (const [model, mu] of models) {
        deps.insertUsageRecord({
          userId,
          groupFolder,
          agentId,
          messageId,
          model,
          inputTokens: mu.inputTokens,
          outputTokens: mu.outputTokens,
          cacheReadInputTokens: cacheReadAssigned
            ? 0
            : usage.cacheReadInputTokens,
          cacheCreationInputTokens: cacheReadAssigned
            ? 0
            : usage.cacheCreationInputTokens,
          costUSD: mu.costUSD,
          durationMs: usage.durationMs,
          numTurns: usage.numTurns,
          source: 'agent',
        });
        cacheReadAssigned = true;
      }
      return;
    }

    deps.insertUsageRecord({
      userId,
      groupFolder,
      agentId,
      messageId,
      model: 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      costUSD: usage.costUSD,
      durationMs: usage.durationMs,
      numTurns: usage.numTurns,
      source: 'agent',
    });
  }

  function sendSystemMessage(jid: string, type: string, detail: string): void {
    const msgId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    deps.ensureChatExists(jid);
    deps.storeMessageDirect(
      msgId,
      jid,
      '__system__',
      'system',
      `${type}:${detail}`,
      timestamp,
      true,
    );
    deps.broadcastNewMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: '__system__',
      sender_name: 'system',
      content: `${type}:${detail}`,
      timestamp,
      is_from_me: true,
    });
  }

  function sendBillingDeniedMessage(jid: string, content: string): string {
    const msgId = `sys_quota_${Date.now()}`;
    const timestamp = new Date().toISOString();
    deps.ensureChatExists(jid);
    deps.storeMessageDirect(
      msgId,
      jid,
      '__billing__',
      deps.assistantName,
      content,
      timestamp,
      true,
    );
    deps.broadcastNewMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: '__billing__',
      sender_name: deps.assistantName,
      content,
      timestamp,
      is_from_me: true,
    });
    return msgId;
  }

  function getEffectiveRuntime(group: RegisteredGroup): RuntimeType {
    return deps.getSystemSettings().defaultRuntime;
  }

  async function setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (isTyping && deps.hasActiveStreamingSession(jid)) {
      deps.broadcastTyping(jid, isTyping);
      return;
    }
    await deps.imManager.setTyping(jid, isTyping);
    deps.broadcastTyping(jid, isTyping);
  }

  async function sendMessage(
    jid: string,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<string | undefined> {
    const isIMChannel = deps.getChannelType(jid) !== null;
    const sendToIM = options.sendToIM ?? isIMChannel;
    try {
      if (sendToIM && isIMChannel) {
        try {
          const localImagePaths =
            options.localImagePaths ??
            deps.extractLocalImImagePaths(
              text,
              deps.resolveEffectiveFolder(jid),
            );
          await deps.imManager.sendMessage(jid, text, localImagePaths);
        } catch (err) {
          log.error({ jid, err }, 'Failed to send message to IM channel');
        }
      }

      const msgId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      deps.ensureChatExists(jid);
      const persistedMsgId = deps.storeMessageDirect(
        msgId,
        jid,
        'happypaw-agent',
        deps.assistantName,
        text,
        timestamp,
        true,
        { meta: options.messageMeta },
      );

      deps.broadcastNewMessage(
        jid,
        {
          id: persistedMsgId,
          chat_jid: jid,
          sender: 'happypaw-agent',
          sender_name: deps.assistantName,
          content: text,
          timestamp,
          is_from_me: true,
          turn_id: options.messageMeta?.turnId ?? null,
          session_id: options.messageMeta?.sessionId ?? null,
          sdk_message_uuid: options.messageMeta?.sdkMessageUuid ?? null,
          source_kind: options.messageMeta?.sourceKind ?? null,
          finalization_reason: options.messageMeta?.finalizationReason ?? null,
        },
        undefined,
        options.source,
      );
      log.info({ jid, length: text.length, sendToIM }, 'Message sent');
      if (!options.source) {
        deps.broadcastToWebClients(jid, text);
      }
      return persistedMsgId;
    } catch (err) {
      log.error({ jid, err }, 'Failed to send message');
      return undefined;
    }
  }

  async function runTerminalWarmup(chatJid: string): Promise<void> {
    const group = deps.registeredGroups[chatJid];
    if (!group) return;
    if ((group.executionMode || 'container') === 'host') return;

    log.info({ chatJid, group: group.name }, 'Starting terminal warmup run');

    const warmupReadyToken = '<terminal_ready>';
    const warmupPrompt = [
      '这是系统触发的终端预热请求。',
      `请只回复 ${warmupReadyToken}，不要回复其它内容，也不要调用工具。`,
    ].join(' ');

    let bootstrapCompleted = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.debug(
          { chatJid, group: group.name },
          'Terminal warmup idle timeout, closing stdin',
        );
        deps.queue.closeStdin(chatJid);
      }, deps.getSystemSettings().idleTimeout);
    };

    try {
      const output = await runAgent(
        group,
        warmupPrompt,
        chatJid,
        undefined,
        async (result) => {
          if (result.status === 'stream' && result.streamEvent) {
            deps.broadcastStreamEvent(chatJid, result.streamEvent);
            return;
          }

          if (result.status === 'error') return;

          if (result.result === null) {
            if (!bootstrapCompleted) {
              bootstrapCompleted = true;
              resetIdleTimer();
            }
            return;
          }

          if (!bootstrapCompleted) return;

          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = stripAgentInternalTags(raw);
          if (!text || text === warmupReadyToken) return;
          await sendMessage(chatJid, text);
          resetIdleTimer();
        },
      );

      if (output.status === 'error') {
        log.warn(
          { chatJid, group: group.name, error: output.error },
          'Terminal warmup run ended with error',
        );
      } else {
        log.info(
          { chatJid, group: group.name },
          'Terminal warmup run completed',
        );
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  function ensureTerminalContainerStarted(chatJid: string): boolean {
    const group = deps.registeredGroups[chatJid];
    if (!group) return false;
    if ((group.executionMode || 'container') === 'host') return false;

    const status = deps.queue.getStatus();
    const groupStatus = status.groups.find((g) => g.jid === chatJid);
    if (groupStatus?.active) return true;
    if (deps.terminalWarmupInFlight.has(chatJid)) return true;

    deps.terminalWarmupInFlight.add(chatJid);
    const taskId = `terminal-warmup:${chatJid}`;
    deps.queue.enqueueTask(chatJid, taskId, async () => {
      try {
        await runTerminalWarmup(chatJid);
      } finally {
        deps.terminalWarmupInFlight.delete(chatJid);
      }
    });
    return true;
  }

  const runAgent: RunAgentFn = async (
    group,
    prompt,
    chatJid,
    turnId,
    onOutput,
    images,
  ) => {
    const isHome = !!group.is_home;
    const isAdminHome = isHome && group.folder === MAIN_GROUP_FOLDER;
    const runtime = getEffectiveRuntime(group);
    const sessionRecord = deps.sessions[group.folder];
    const sessionId = sessionRecord?.sessionId;

    const tasks = deps.getAllTasks();
    deps.writeTasksSnapshot(
      group.folder,
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

    deps.writeGroupsSnapshot(
      group.folder,
      isAdminHome,
      deps.getAvailableGroups(),
      new Set(Object.keys(deps.registeredGroups)),
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          deps.queue.markRunnerActivity(chatJid);
          if (
            (output.status === 'success' && output.result !== null) ||
            (output.status === 'stream' &&
              output.streamEvent?.eventType === 'status' &&
              output.streamEvent.statusText === 'interrupted')
          ) {
            deps.queue.markRunnerQueryIdle(chatJid);
          }
          if (output.newSessionId && output.status !== 'error') {
            const nextSession: RuntimeSessionRecord = {
              sessionId: output.newSessionId,
            };
            deps.sessions[group.folder] = nextSession;
            deps.setSession(group.folder, output.newSessionId, undefined);
          }
          await onOutput(output);
        }
      : undefined;

    deps.getIpcRuntime().watchGroup(group.folder);
    try {
      const executionMode = group.executionMode || 'container';
      const onProcessCb = (proc: ChildProcess, identifier: string) => {
        const containerName = executionMode === 'container' ? identifier : null;
        deps.queue.registerProcess(
          chatJid,
          proc,
          containerName,
          group.folder,
          identifier,
        );
      };

      const ownerHomeFolder = deps.resolveOwnerHomeFolder(group);

      const output =
        executionMode === 'host'
          ? await deps.runHostAgent(
              group,
              {
                prompt,
                sessionId,
                runtime,
                turnId,
                groupFolder: group.folder,
                chatJid,
                isMain: isAdminHome,
                isHome,
                isAdminHome,
                images,
              },
              onProcessCb,
              wrappedOnOutput,
              ownerHomeFolder,
            )
          : await deps.runContainerAgent(
              group,
              {
                prompt,
                sessionId,
                runtime,
                turnId,
                groupFolder: group.folder,
                chatJid,
                isMain: isAdminHome,
                isHome,
                isAdminHome,
                images,
              },
              onProcessCb,
              wrappedOnOutput,
              ownerHomeFolder,
            );

      if (output.newSessionId && output.status !== 'error') {
        const nextSession: RuntimeSessionRecord = {
          sessionId: output.newSessionId,
        };
        deps.sessions[group.folder] = nextSession;
        deps.setSession(group.folder, output.newSessionId, undefined);
      }

      if (output.status === 'closed') {
        return { status: 'closed' };
      }

      if (output.status === 'error') {
        log.error({ group: group.name, error: output.error }, 'Agent error');
        if (output.result && wrappedOnOutput) {
          try {
            await wrappedOnOutput(output);
          } catch (err) {
            log.error(
              { group: group.name, err },
              'Failed to emit agent error output',
            );
          }
        }
        return { status: 'error', error: output.error };
      }

      return { status: 'success' };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ group: group.name, err }, 'Agent error');
      return { status: 'error', error: errorMsg };
    } finally {
      deps.getIpcRuntime().unwatchGroup(group.folder);
    }
  };

  return {
    writeUsageRecords,
    sendSystemMessage,
    sendBillingDeniedMessage,
    getEffectiveRuntime,
    setTyping,
    sendMessage,
    runAgent,
    ensureTerminalContainerStarted,
  };
}

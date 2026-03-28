import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { GroupQueue } from './group-queue.js';
import type {
  AgentKind,
  AgentStatus,
  MessageCursor,
  MessageFinalizationReason,
  MessageSourceKind,
  NewMessage,
  RegisteredGroup,
  RuntimeSessionRecord,
} from './types.js';

export const EMPTY_CURSOR: MessageCursor = { timestamp: '', id: '' };

const STREAMING_BUFFER_INTERVAL_MS = 5000;

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

export function isCursorAfter(
  candidate: MessageCursor,
  base: MessageCursor,
): boolean {
  if (candidate.timestamp > base.timestamp) return true;
  if (candidate.timestamp < base.timestamp) return false;
  return candidate.id > base.id;
}

export function normalizeCursor(value: unknown): MessageCursor {
  if (typeof value === 'string') {
    return { timestamp: value, id: '' };
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { timestamp?: unknown }).timestamp === 'string'
  ) {
    const maybeId = (value as { id?: unknown }).id;
    return {
      timestamp: (value as { timestamp: string }).timestamp,
      id: typeof maybeId === 'string' ? maybeId : '',
    };
  }
  return { ...EMPTY_CURSOR };
}

export function buildInterruptedReply(
  partialText: string,
  thinkingText?: string,
): string {
  const trimmed = partialText.trimEnd();
  const trimmedThinking = thinkingText?.trimEnd();
  const parts: string[] = [];
  if (trimmedThinking) {
    parts.push(
      `<details>\n<summary>💭 Reasoning (已中断)</summary>\n\n${trimmedThinking}\n\n</details>`,
    );
  }
  if (trimmed) {
    parts.push(trimmed);
  }
  parts.push('---\n*⚠️ 已中断*');
  return parts.join('\n\n');
}

export function buildOverflowPartialReply(partialText: string): string {
  const trimmed = partialText.trimEnd();
  return trimmed
    ? `${trimmed}\n\n---\n*⚠️ 上下文压缩中，稍后自动继续*`
    : '*⚠️ 上下文压缩中，稍后自动继续*';
}

export function createCursorStateHelpers(deps: {
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  getLastCommittedCursor: () => Record<string, MessageCursor>;
  saveState: () => void;
}): {
  setCursors: (jid: string, cursor: MessageCursor) => void;
  advanceCursors: (jid: string, candidate: MessageCursor) => void;
} {
  function setCursors(jid: string, cursor: MessageCursor): void {
    deps.getLastAgentTimestamp()[jid] = cursor;
    deps.getLastCommittedCursor()[jid] = cursor;
    deps.saveState();
  }

  function advanceCursors(jid: string, candidate: MessageCursor): void {
    const lastAgentTimestamp = deps.getLastAgentTimestamp();
    const current = lastAgentTimestamp[jid];
    const target =
      current && current.timestamp > candidate.timestamp ? current : candidate;
    lastAgentTimestamp[jid] = target;
    deps.getLastCommittedCursor()[jid] = target;
    deps.saveState();
  }

  return { setCursors, advanceCursors };
}

function encodeJidForFilename(jid: string): string {
  return Buffer.from(jid).toString('base64url');
}

function decodeJidFromFilename(filename: string): string {
  const name = filename.endsWith('.txt') ? filename.slice(0, -4) : filename;
  return Buffer.from(name, 'base64url').toString();
}

export function createStreamingBufferManager(deps: {
  dataDir: string;
  assistantName: string;
  shutdownSavedJids: Set<string>;
  logger: LoggerLike;
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
}): {
  cleanStreamingBufferDir: () => void;
  flushStreamingBuffer: () => void;
  saveInterruptedStreamingMessages: () => void;
  recoverStreamingBuffer: () => void;
  startStreamingBuffer: () => void;
  stopStreamingBuffer: () => void;
} {
  const streamingBufferDir = path.join(deps.dataDir, 'streaming-buffer');
  let streamingBufferInterval: ReturnType<typeof setInterval> | null = null;

  function cleanStreamingBufferDir(): void {
    try {
      if (!fs.existsSync(streamingBufferDir)) return;
      for (const f of fs.readdirSync(streamingBufferDir)) {
        try {
          fs.unlinkSync(path.join(streamingBufferDir, f));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  function flushStreamingBuffer(): void {
    try {
      const activeTexts = deps.getActiveStreamingTexts();
      if (activeTexts.size === 0) {
        cleanStreamingBufferDir();
        return;
      }

      fs.mkdirSync(streamingBufferDir, { recursive: true });

      const activeFiles = new Set<string>();
      for (const [jid, text] of activeTexts) {
        const filename = encodeJidForFilename(jid) + '.txt';
        activeFiles.add(filename);
        const filePath = path.join(streamingBufferDir, filename);
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, text);
        fs.renameSync(tmpPath, filePath);
      }

      try {
        for (const f of fs.readdirSync(streamingBufferDir)) {
          if (f.endsWith('.txt') && !activeFiles.has(f)) {
            fs.unlinkSync(path.join(streamingBufferDir, f));
          }
        }
      } catch {
        /* ignore cleanup errors */
      }
    } catch (err) {
      deps.logger.debug({ err }, 'Error flushing streaming buffer');
    }
  }

  function saveInterruptedStreamingMessages(): void {
    try {
      const activeTexts = deps.getActiveStreamingTexts();
      if (activeTexts.size === 0) return;

      deps.logger.info(
        { count: activeTexts.size },
        'Saving interrupted streaming messages to DB',
      );

      for (const [jid, partialText] of activeTexts) {
        if (!partialText.trim()) {
          deps.shutdownSavedJids.add(jid);
          continue;
        }
        const interruptedText = buildInterruptedReply(partialText);
        const msgId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        deps.ensureChatExists(jid);
        deps.storeMessageDirect(
          msgId,
          jid,
          'happypaw-agent',
          deps.assistantName,
          interruptedText,
          timestamp,
          true,
          {
            meta: {
              sourceKind: 'interrupt_partial',
              finalizationReason: 'shutdown',
            },
          },
        );
        deps.shutdownSavedJids.add(jid);
      }
    } catch (err) {
      deps.logger.warn({ err }, 'Error saving interrupted streaming messages');
    }

    cleanStreamingBufferDir();
  }

  function recoverStreamingBuffer(): void {
    try {
      if (!fs.existsSync(streamingBufferDir)) return;

      const txtFiles = fs
        .readdirSync(streamingBufferDir)
        .filter((f) => f.endsWith('.txt'));
      if (txtFiles.length === 0) return;

      deps.logger.info(
        { count: txtFiles.length },
        'Recovering interrupted streaming messages from buffer files',
      );

      for (const filename of txtFiles) {
        try {
          const jid = decodeJidFromFilename(filename);
          const text = fs.readFileSync(
            path.join(streamingBufferDir, filename),
            'utf-8',
          );
          if (text.trim()) {
            const interruptedText = buildInterruptedReply(text);
            const msgId = crypto.randomUUID();
            const timestamp = new Date().toISOString();
            deps.ensureChatExists(jid);
            deps.storeMessageDirect(
              msgId,
              jid,
              'happypaw-agent',
              deps.assistantName,
              interruptedText,
              timestamp,
              true,
              {
                meta: {
                  sourceKind: 'interrupt_partial',
                  finalizationReason: 'crash_recovery',
                },
              },
            );
            deps.logger.info(
              { jid, textLen: text.length },
              'Recovered interrupted streaming message',
            );
          }
          fs.unlinkSync(path.join(streamingBufferDir, filename));
        } catch (err) {
          deps.logger.warn(
            { err, filename },
            'Error recovering streaming buffer file',
          );
        }
      }
    } catch (err) {
      deps.logger.warn({ err }, 'Error recovering streaming buffer');
    }
  }

  function startStreamingBuffer(): void {
    streamingBufferInterval = setInterval(
      flushStreamingBuffer,
      STREAMING_BUFFER_INTERVAL_MS,
    );
  }

  function stopStreamingBuffer(): void {
    if (streamingBufferInterval) {
      clearInterval(streamingBufferInterval);
      streamingBufferInterval = null;
    }
  }

  return {
    cleanStreamingBufferDir,
    flushStreamingBuffer,
    saveInterruptedStreamingMessages,
    recoverStreamingBuffer,
    startStreamingBuffer,
    stopStreamingBuffer,
  };
}

export function recoverStuckPendingGroups(deps: {
  queue: Pick<GroupQueue, 'getStuckPendingGroups' | 'restartGroup'>;
  logger: LoggerLike;
  idleThresholdMs: number;
}): void {
  const stuckGroups = deps.queue.getStuckPendingGroups(deps.idleThresholdMs);
  for (const { jid, idleMs } of stuckGroups) {
    deps.logger.warn(
      { chatJid: jid, idleMs },
      'Runner has pending messages but no activity; restarting',
    );
    deps.queue.restartGroup(jid).catch((err) => {
      deps.logger.error?.(
        { chatJid: jid, err },
        'Failed to restart stuck runner with pending messages',
      );
    });
  }
}

export function recoverPendingMessages(deps: {
  logger: LoggerLike;
  queue: Pick<GroupQueue, 'enqueueMessageCheck'>;
  recoveryGroups: Set<string>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getLastCommittedCursor: () => Record<string, MessageCursor>;
  getSessions: () => Record<string, RuntimeSessionRecord>;
  getMessagesSince: (
    chatJid: string,
    sinceCursor: MessageCursor,
  ) => Array<unknown>;
  clearPersistedRuntimeStateForRecovery: (
    sessions: Record<string, RuntimeSessionRecord>,
    groupFolder: string,
    agentId?: string,
  ) => void;
}): void {
  for (const [chatJid, group] of Object.entries(deps.getRegisteredGroups())) {
    const sinceCursor = deps.getLastCommittedCursor()[chatJid];
    if (!sinceCursor) continue;

    const pending = deps.getMessagesSince(chatJid, sinceCursor);
    if (pending.length > 0) {
      const sessions = deps.getSessions();
      if (sessions[group.folder]) {
        deps.logger.info(
          { group: group.name, folder: group.folder },
          'Recovery: clearing stale session to prevent session ghost',
        );
        deps.clearPersistedRuntimeStateForRecovery(sessions, group.folder);
      }

      deps.logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      deps.recoveryGroups.add(chatJid);
      deps.queue.enqueueMessageCheck(chatJid);
    }
  }
}

export function recoverConversationAgents(deps: {
  logger: LoggerLike;
  queue: Pick<GroupQueue, 'enqueueTask'>;
  assistantName: string;
  emptyCursor: MessageCursor;
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  getSessions: () => Record<string, RuntimeSessionRecord>;
  listActiveConversationAgents: () => Array<{
    id: string;
    chat_jid: string;
    group_folder: string;
    name: string;
    prompt: string;
    status: AgentStatus;
    kind: AgentKind;
    result_summary: string | null;
  }>;
  updateAgentStatus: (
    agentId: string,
    status: AgentStatus,
    resultSummary?: string,
  ) => void;
  broadcastAgentStatus: (
    chatJid: string,
    agentId: string,
    status: AgentStatus,
    name: string,
    prompt: string,
    resultSummary?: string,
    kind?: AgentKind,
  ) => void;
  getMessagesSince: (
    chatJid: string,
    sinceCursor: MessageCursor,
  ) => Array<unknown>;
  getRuntimeSession: (
    groupFolder: string,
    agentId?: string,
  ) => RuntimeSessionRecord | undefined;
  clearPersistedRuntimeStateForRecovery: (
    sessions: Record<string, RuntimeSessionRecord>,
    groupFolder: string,
    agentId?: string,
  ) => void;
  storeMessageDirect: (
    id: string,
    chatJid: string,
    sender: string,
    senderName: string,
    content: string,
    timestamp: string,
    isFromMe: boolean,
  ) => string | number;
  broadcastNewMessage: (
    chatJid: string,
    message: NewMessage & { is_from_me?: boolean },
  ) => void;
  processAgentConversation: (chatJid: string, agentId: string) => Promise<void>;
}): void {
  const agents = deps.listActiveConversationAgents();
  if (agents.length === 0) return;

  deps.logger.info(
    { count: agents.length },
    'Recovery: found active conversation agents from previous session',
  );

  for (const agent of agents) {
    try {
      const chatJid = agent.chat_jid;
      const agentId = agent.id;

      if (agent.status === 'running') {
        deps.updateAgentStatus(agentId, 'idle');
        deps.broadcastAgentStatus(
          chatJid,
          agentId,
          'idle',
          agent.name,
          agent.prompt,
          agent.result_summary ?? undefined,
          agent.kind,
        );
      }

      const virtualChatJid = `${chatJid}#agent:${agentId}`;
      const sinceCursor =
        deps.getLastAgentTimestamp()[virtualChatJid] || deps.emptyCursor;
      const pending = deps.getMessagesSince(virtualChatJid, sinceCursor);

      if (pending.length > 0) {
        const persistedAgentSession = deps.getRuntimeSession(
          agent.group_folder,
          agentId,
        );
        if (persistedAgentSession) {
          deps.logger.info(
            {
              agentId,
              agentName: agent.name,
              folder: agent.group_folder,
            },
            'Recovery: clearing stale persisted agent runtime state before requeue',
          );
          deps.clearPersistedRuntimeStateForRecovery(
            deps.getSessions(),
            agent.group_folder,
            agentId,
          );
        }

        deps.logger.info(
          { agentId, agentName: agent.name, pendingCount: pending.length },
          'Recovery: re-triggering conversation agent with pending messages',
        );

        const now = new Date().toISOString();
        const noticeId = `system-recover-${agentId}-${Date.now()}`;
        deps.storeMessageDirect(
          noticeId,
          virtualChatJid,
          'system',
          deps.assistantName,
          '服务已重启，正在恢复上次未完成的任务...',
          now,
          true,
        );
        deps.broadcastNewMessage(virtualChatJid, {
          id: noticeId,
          chat_jid: virtualChatJid,
          sender: 'system',
          sender_name: deps.assistantName,
          content: '服务已重启，正在恢复上次未完成的任务...',
          timestamp: now,
          is_from_me: true,
          source_jid: virtualChatJid,
        });

        const taskId = `agent-recover:${agentId}:${Date.now()}`;
        deps.queue.enqueueTask(virtualChatJid, taskId, async () => {
          await deps.processAgentConversation(chatJid, agentId);
        });
      }
    } catch (err) {
      deps.logger.error?.(
        { err, agentId: agent.id, groupFolder: agent.group_folder },
        'Recovery: failed to recover conversation agent, skipping',
      );
    }
  }
}

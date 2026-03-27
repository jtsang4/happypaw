import { MAIN_GROUP_FOLDER } from './config.js';
import type { ContainerOutput } from './container-runner.js';
import {
  createAgent,
  deleteRouterState,
  deleteSession,
  getAgent,
  getAllRegisteredGroups,
  getMessagesPage,
  getMessagesSince,
  getRunningTaskAgentsByChat,
  getRuntimeSession,
  getUserById,
  listAgentsByJid,
  markRunningTaskAgentsAsError,
  setRouterState,
  updateAgentInfo,
  updateAgentStatus,
  updateLatestMessageTokenUsage,
} from './db.js';
import {
  registerMessageIdMapping,
  registerStreamingSession,
  type StreamingCardController,
  unregisterStreamingSession,
} from './feishu-streaming-card.js';
import { getChannelType, extractChatId } from './im-channel.js';
import { imManager } from './im-manager.js';
import { LEGACY_AGENT_SENDER } from './legacy-product.js';
import { logger } from './logger.js';
import { normalizeImageAttachments } from './message-attachments.js';
import {
  buildInterruptedReply,
  buildOverflowPartialReply,
  EMPTY_CURSOR,
} from './index-recovery.js';
import { getSystemSettings } from './runtime-config.js';
import { clearSessionRuntimeFiles } from './runtime-state-cleanup.js';
import type {
  MessageCursor,
  NewMessage,
  RegisteredGroup,
  RuntimeSessionRecord,
  RuntimeType,
  StreamEvent,
} from './types.js';
import { isSystemMaintenanceNoise, stripAgentInternalTags } from './utils.js';
import {
  broadcastAgentStatus,
  broadcastBillingUpdate,
  broadcastStreamEvent,
  clearStreamingSnapshot,
} from './web.js';
import {
  checkBillingAccessFresh,
  deductUsageCost,
  formatBillingAccessDeniedMessage,
  updateUsage,
} from './billing.js';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  isShared = false,
): string {
  const lines = messages.map((m) => {
    const content = isShared ? `[${m.sender_name}] ${m.content}` : m.content;
    const sourceJid = m.source_jid || m.chat_jid;
    const channelType = getChannelType(sourceJid);
    let sourceAttr = '';
    if (channelType) {
      const chatId = extractChatId(sourceJid);
      sourceAttr = ` source="${escapeXml(channelType)}:${escapeXml(chatId)}"`;
    }
    return `<message sender="${escapeXml(m.sender_name)}"${sourceAttr} time="${m.timestamp}">${escapeXml(content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function collectMessageImages(
  chatJid: string,
  messages: NewMessage[],
): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const msg of messages) {
    if (!msg.attachments) continue;
    try {
      const parsed = JSON.parse(msg.attachments);
      const normalized = normalizeImageAttachments(parsed, {
        onMimeMismatch: ({ declaredMime, detectedMime }) => {
          logger.warn(
            { chatJid, messageId: msg.id, declaredMime, detectedMime },
            'Attachment MIME mismatch detected, using detected MIME',
          );
        },
      });
      for (const item of normalized) {
        images.push({ data: item.data, mimeType: item.mimeType });
      }
    } catch {
      logger.warn(
        { chatJid, messageId: msg.id },
        'Failed to parse message attachments',
      );
    }
  }
  return images;
}

/**
 * Feed a stream event into a Feishu streaming card controller.
 * Centralizes the event → card mapping for both main and sub-agent handlers.
 */
export function feedStreamEventToCard(
  session: StreamingCardController,
  se: StreamEvent,
  accumulatedText: string,
): void {
  switch (se.eventType) {
    case 'text_delta':
      if (se.text) session.append(accumulatedText);
      break;
    case 'thinking_delta':
      if (se.text) {
        session.appendThinking(se.text);
      } else if (!accumulatedText) {
        session.setThinking();
      }
      break;
    case 'tool_use_start':
      if (se.toolUseId && se.toolName) {
        session.startTool(se.toolUseId, se.toolName);
        const label = se.skillName ? `技能 ${se.skillName}` : se.toolName;
        session.pushRecentEvent(`🔄 ${label}`);
      }
      break;
    case 'tool_use_end':
      if (se.toolUseId) {
        const info = session.getToolInfo(se.toolUseId);
        session.endTool(se.toolUseId, false);
        if (info) session.pushRecentEvent(`✅ ${info.name}`);
      }
      break;
    case 'tool_progress':
      if (se.toolUseId && se.toolInputSummary) {
        session.updateToolSummary(se.toolUseId, se.toolInputSummary);
      }
      break;
    case 'status':
      if (se.statusText && se.statusText !== 'interrupted') {
        session.setSystemStatus(se.statusText);
      }
      break;
    case 'hook_started':
      session.setHook({
        hookName: se.hookName || '',
        hookEvent: se.hookEvent || '',
      });
      break;
    case 'hook_response':
      if (se.hookName) {
        session.pushRecentEvent(`✅ Hook: ${se.hookName}`);
      }
      session.setHook(null);
      break;
    case 'todo_update':
      if (se.todos) session.setTodos(se.todos);
      break;
    case 'task_start':
      if (se.toolUseId) {
        const label = se.taskDescription
          ? `Task: ${se.taskDescription.slice(0, 40)}`
          : 'Task';
        session.startTool(se.toolUseId, label);
        session.pushRecentEvent(`🚀 ${label}`);
      }
      break;
    case 'task_notification':
      if (se.toolUseId || se.taskId) {
        const id = se.toolUseId || se.taskId || '';
        session.endTool(id, false);
        const label = se.taskSummary
          ? `Task: ${se.taskSummary.slice(0, 40)}`
          : 'Task 完成';
        session.pushRecentEvent(`✅ ${label}`);
      }
      break;
    case 'hook_progress':
      session.setHook({
        hookName: se.hookName || '',
        hookEvent: se.hookEvent || '',
      });
      break;
    case 'usage':
      if (se.usage) session.patchUsageNote(se.usage);
      break;
    case 'init':
      break;
  }
}

interface SendMessageOptions {
  sendToIM?: boolean;
  localImagePaths?: string[];
  source?: string;
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

interface UsagePayload {
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

interface MainConversationRuntimeDeps {
  registeredGroups: Record<string, RegisteredGroup>;
  sessions: Record<string, RuntimeSessionRecord>;
  lastAgentTimestamp: Record<string, MessageCursor>;
  recoveryGroups: Set<string>;
  activeRouteUpdaters: Map<string, (newSourceJid: string | null) => void>;
  shutdownSavedJids: Set<string>;
  consecutiveOomExits: Record<string, number>;
  oomExitRe: RegExp;
  oomAutoResetThreshold: number;
  resolveEffectiveGroup: (group: RegisteredGroup) => {
    effectiveGroup: RegisteredGroup;
    isHome: boolean;
  };
  setActiveImReplyRoute: (folder: string, replyJid: string | null) => void;
  clearActiveImReplyRoute: (folder: string) => void;
  advanceCursors: (jid: string, candidate: MessageCursor) => void;
  isGroupShared: (folder: string) => boolean;
  closeStdin: (chatJid: string) => void;
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    turnId?: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    images?: Array<{ data: string; mimeType?: string }>,
  ) => Promise<{ status: 'success' | 'error' | 'closed'; error?: string }>;
  getEffectiveRuntime: (group: RegisteredGroup) => RuntimeType;
  sendBillingDeniedMessage: (jid: string, content: string) => string;
  setTyping: (jid: string, isTyping: boolean) => Promise<void>;
  sendMessage: (
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ) => Promise<string | undefined>;
  sendSystemMessage: (jid: string, type: string, detail: string) => void;
  extractLocalImImagePaths: (text: string, groupFolder?: string) => string[];
  sendImWithFailTracking: (
    imJid: string,
    text: string,
    localImagePaths: string[],
  ) => void;
  writeUsageRecords: (opts: {
    userId: string;
    groupFolder: string;
    messageId?: string;
    agentId?: string;
    usage: UsagePayload;
  }) => void;
}

export function createMainConversationRuntime(
  deps: MainConversationRuntimeDeps,
): {
  processGroupMessages: (chatJid: string) => Promise<boolean>;
} {
  async function processGroupMessages(chatJid: string): Promise<boolean> {
    let group = deps.registeredGroups[chatJid];
    if (!group) {
      Object.keys(deps.registeredGroups).forEach((key) => {
        delete deps.registeredGroups[key];
      });
      Object.assign(deps.registeredGroups, getAllRegisteredGroups());
      group = deps.registeredGroups[chatJid];
    }
    if (!group) return true;

    if (group.activation_mode === 'disabled') {
      logger.debug({ chatJid }, 'Group activation_mode is disabled, skipping');
      return true;
    }

    const resolved = deps.resolveEffectiveGroup(group);
    let effectiveGroup = resolved.effectiveGroup;

    const sinceCursor = deps.lastAgentTimestamp[chatJid] || EMPTY_CURSOR;
    const missedMessages = getMessagesSince(chatJid, sinceCursor);
    if (missedMessages.length === 0) return true;

    if (chatJid === `web:${MAIN_GROUP_FOLDER}` && effectiveGroup.is_home) {
      for (let i = missedMessages.length - 1; i >= 0; i--) {
        const sender = missedMessages[i]?.sender;
        if (
          !sender ||
          sender === 'happypaw-agent' ||
          sender === LEGACY_AGENT_SENDER ||
          sender === '__system__'
        ) {
          continue;
        }
        const senderUser = getUserById(sender);
        if (senderUser?.status === 'active' && senderUser.role === 'admin') {
          effectiveGroup = { ...effectiveGroup, created_by: senderUser.id };
          break;
        }
      }
    }

    const directImReply = getChannelType(chatJid) !== null;
    let replySourceImJid: string | null = null;
    if (!directImReply) {
      const firstSourceJid = missedMessages[0]?.source_jid || chatJid;
      const allSameImSource =
        getChannelType(firstSourceJid) !== null &&
        missedMessages.every(
          (m) => (m.source_jid || chatJid) === firstSourceJid,
        );
      if (allSameImSource) {
        replySourceImJid = firstSourceJid;
      }
    } else {
      replySourceImJid = chatJid;
    }
    deps.setActiveImReplyRoute(effectiveGroup.folder, replySourceImJid);

    const shared = deps.isGroupShared(group.folder);
    let prompt = formatMessages(missedMessages, shared);

    const isRecovery = deps.recoveryGroups.delete(chatJid);
    if (isRecovery) {
      const RECOVERY_HISTORY_LIMIT = 20;
      const recentHistory = getMessagesPage(
        chatJid,
        undefined,
        RECOVERY_HISTORY_LIMIT,
      );
      const pendingIds = new Set(missedMessages.map((m) => m.id));
      const historyMsgs = recentHistory
        .reverse()
        .filter((m) => !pendingIds.has(m.id));
      if (historyMsgs.length > 0) {
        const historyLines = historyMsgs.map((m) => {
          const role = m.is_from_me ? 'assistant' : m.sender_name;
          const truncated =
            m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
          const cleaned = truncated.replace(/[\uD800-\uDFFF]/g, '');
          return `[${role}] ${cleaned}`;
        });
        prompt =
          '<system_context>\n' +
          '服务刚重启，当前为新会话。以下是重启前的最近对话记录，供你了解上下文：\n\n' +
          historyLines.join('\n') +
          '\n</system_context>\n\n' +
          prompt;
        logger.info(
          { group: group.name, historyCount: historyMsgs.length },
          'Recovery: injected recent conversation history into prompt',
        );
      }
    }

    const images = collectMessageImages(chatJid, missedMessages);
    const imagesForAgent = images.length > 0 ? images : undefined;

    logger.info(
      {
        group: group.name,
        messageCount: missedMessages.length,
        directImReply,
        imageCount: images.length,
        shared,
        isRecovery,
      },
      'Processing messages',
    );

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        deps.closeStdin(chatJid);
      }, getSystemSettings().idleTimeout);
    };

    await deps.setTyping(chatJid, true);
    let hadError = false;
    let sentReply = false;
    let lastError = '';
    let cursorCommitted = false;
    let lastReplyMsgId: string | undefined;
    let lastSavedTurnId: string | undefined;
    const queryTaskIds = new Set<string>();
    const lastProcessed = missedMessages[missedMessages.length - 1];

    let streamingSessionJid = replySourceImJid ?? chatJid;
    const makeOnCardCreated = (jid: string) => (messageId: string) =>
      registerMessageIdMapping(messageId, jid);
    let streamingSession = imManager.createStreamingSession(
      streamingSessionJid,
      makeOnCardCreated(streamingSessionJid),
    );
    let streamingAccumulatedText = '';
    let streamingAccumulatedThinking = '';
    let streamInterrupted = false;
    if (streamingSession) {
      registerStreamingSession(streamingSessionJid, streamingSession);
      logger.debug({ chatJid }, 'Streaming card session created for Feishu');
    }

    deps.activeRouteUpdaters.set(effectiveGroup.folder, (newSourceJid) => {
      const newImJid =
        newSourceJid && getChannelType(newSourceJid) ? newSourceJid : null;
      sentReply = false;
      if (newImJid === replySourceImJid) return;
      logger.debug(
        { chatJid, oldRoute: replySourceImJid, newRoute: newImJid },
        'Reply route updated via IPC injection',
      );
      replySourceImJid = newImJid;
      deps.setActiveImReplyRoute(effectiveGroup.folder, replySourceImJid);

      const newStreamingJid =
        replySourceImJid ??
        (directImReply ? `web:${effectiveGroup.folder}` : chatJid);
      if (newStreamingJid !== streamingSessionJid) {
        if (streamingSession) {
          if (streamingSession.isActive()) streamingSession.dispose();
          unregisterStreamingSession(streamingSessionJid);
        }
        streamingSessionJid = newStreamingJid;
        streamingSession = imManager.createStreamingSession(
          streamingSessionJid,
          makeOnCardCreated(streamingSessionJid),
        );
        streamingAccumulatedText = '';
        streamingAccumulatedThinking = '';
        if (streamingSession) {
          registerStreamingSession(streamingSessionJid, streamingSession);
        }
      }
    });

    const pickRunningTaskForNotification = (): string | null => {
      const runningInQuery = Array.from(queryTaskIds)
        .map((id) => getAgent(id))
        .filter(
          (a): a is NonNullable<ReturnType<typeof getAgent>> =>
            !!a &&
            a.kind === 'task' &&
            a.chat_jid === chatJid &&
            a.status === 'running',
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (runningInQuery.length > 0) {
        return runningInQuery[0].id;
      }
      const runningInChat = listAgentsByJid(chatJid)
        .filter((a) => a.kind === 'task' && a.status === 'running')
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return runningInChat[0]?.id || null;
    };

    const commitCursor = (): void => {
      if (cursorCommitted) return;
      deps.advanceCursors(chatJid, {
        timestamp: lastProcessed.timestamp,
        id: lastProcessed.id,
      });
      cursorCommitted = true;
    };

    if (effectiveGroup.created_by) {
      const owner = getUserById(effectiveGroup.created_by);
      if (owner && owner.role !== 'admin') {
        const accessResult = checkBillingAccessFresh(
          effectiveGroup.created_by,
          owner.role,
        );
        if (!accessResult.allowed) {
          const sysMsg = formatBillingAccessDeniedMessage(accessResult);
          deps.sendBillingDeniedMessage(chatJid, sysMsg);
          commitCursor();
          await deps.setTyping(chatJid, false);
          logger.info(
            {
              chatJid,
              userId: effectiveGroup.created_by,
              reason: accessResult.reason,
              blockType: accessResult.blockType,
            },
            'Billing access denied inside processGroupMessages',
          );
          return true;
        }
      }
    }

    let output:
      | { status: 'success' | 'error' | 'closed'; error?: string }
      | undefined;
    const activeMainSession = getRuntimeSession(effectiveGroup.folder);
    let activeSessionId =
      activeMainSession &&
      activeMainSession.runtime === deps.getEffectiveRuntime(effectiveGroup)
        ? activeMainSession.sessionId
        : undefined;
    try {
      output = await deps.runAgent(
        effectiveGroup,
        prompt,
        chatJid,
        lastProcessed.id,
        async (result) => {
          try {
            if (result.newSessionId && result.status !== 'error') {
              activeSessionId = result.newSessionId;
            }
            if (result.status === 'stream' && result.streamEvent) {
              broadcastStreamEvent(chatJid, result.streamEvent);

              if (
                result.streamEvent.eventType === 'text_delta' &&
                result.streamEvent.text
              ) {
                streamingAccumulatedText += result.streamEvent.text;
              }
              if (
                result.streamEvent.eventType === 'thinking_delta' &&
                result.streamEvent.text
              ) {
                streamingAccumulatedThinking += result.streamEvent.text;
              }

              if (streamingSession && !streamingSession.isActive()) {
                unregisterStreamingSession(streamingSessionJid);
                streamingAccumulatedText = '';
                streamingAccumulatedThinking = '';
                streamInterrupted = false;
                streamingSession = imManager.createStreamingSession(
                  streamingSessionJid,
                  makeOnCardCreated(streamingSessionJid),
                );
                if (streamingSession) {
                  registerStreamingSession(
                    streamingSessionJid,
                    streamingSession,
                  );
                  logger.debug(
                    { chatJid },
                    'Rebuilt streaming card for IPC-injected query',
                  );
                }
              }
              if (streamingSession) {
                feedStreamEventToCard(
                  streamingSession,
                  result.streamEvent,
                  streamingAccumulatedText,
                );
              }

              if (
                result.streamEvent.eventType === 'status' &&
                result.streamEvent.statusText === 'interrupted'
              ) {
                streamInterrupted = true;
                const inlineWebJid = chatJid.startsWith('web:')
                  ? chatJid
                  : `web:${effectiveGroup.folder}`;
                const inlineAlreadySaved =
                  deps.shutdownSavedJids.has(chatJid) ||
                  deps.shutdownSavedJids.has(inlineWebJid);
                if (!sentReply && !inlineAlreadySaved) {
                  const interruptedText = buildInterruptedReply(
                    streamingAccumulatedText,
                    streamingAccumulatedThinking,
                  );
                  try {
                    if (streamingSession?.isActive()) {
                      await streamingSession.abort('已中断').catch(() => {});
                    }
                    lastReplyMsgId = await deps.sendMessage(
                      chatJid,
                      interruptedText,
                      {
                        sendToIM: false,
                        messageMeta: {
                          turnId: result.streamEvent.turnId || lastProcessed.id,
                          sessionId:
                            result.streamEvent.sessionId || activeSessionId,
                          sourceKind: 'interrupt_partial',
                          finalizationReason: 'interrupted',
                        },
                      },
                    );
                    sentReply = true;
                    clearStreamingSnapshot(chatJid);
                    streamingAccumulatedText = '';
                    streamingAccumulatedThinking = '';
                    commitCursor();
                  } catch (err) {
                    logger.warn(
                      { err, chatJid },
                      'Failed to save interrupted text on status event',
                    );
                  }
                }
              }

              const se = result.streamEvent;
              if (
                (se.eventType === 'task_start' && se.toolUseId) ||
                (se.eventType === 'tool_use_start' &&
                  se.toolName === 'Task' &&
                  se.toolUseId)
              ) {
                try {
                  const taskId = se.toolUseId;
                  queryTaskIds.add(taskId);
                  const existing = getAgent(taskId);
                  const desc = se.taskDescription || se.toolInputSummary || '';
                  const taskName =
                    desc.slice(0, 40) || existing?.name || 'Task';
                  if (!existing) {
                    createAgent({
                      id: taskId,
                      group_folder: group.folder,
                      chat_jid: chatJid,
                      name: taskName,
                      prompt: desc,
                      status: 'running',
                      kind: 'task',
                      created_by: null,
                      created_at: new Date().toISOString(),
                      completed_at: null,
                      result_summary: null,
                      last_im_jid: null,
                      spawned_from_jid: null,
                    });
                  } else if (se.taskDescription) {
                    updateAgentInfo(
                      taskId,
                      se.taskDescription.slice(0, 40),
                      se.taskDescription,
                    );
                  }
                  broadcastAgentStatus(
                    chatJid,
                    taskId,
                    'running',
                    taskName,
                    desc,
                    undefined,
                    'task',
                  );
                } catch (err) {
                  logger.warn(
                    { err, toolUseId: se.toolUseId },
                    'Failed to persist task_start to DB',
                  );
                }
              }
              if (se.eventType === 'tool_use_end' && se.toolUseId) {
                try {
                  const existing = getAgent(se.toolUseId);
                  if (
                    existing &&
                    existing.kind === 'task' &&
                    existing.status === 'running'
                  ) {
                    updateAgentStatus(se.toolUseId, 'completed');
                    queryTaskIds.delete(existing.id);
                    broadcastAgentStatus(
                      chatJid,
                      existing.id,
                      'completed',
                      existing.name,
                      existing.prompt,
                      existing.result_summary || '任务已完成',
                      'task',
                    );
                  }
                } catch (err) {
                  logger.warn(
                    { err, toolUseId: se.toolUseId },
                    'Failed to persist tool_use_end to DB',
                  );
                }
              }
              if (se.eventType === 'task_notification' && se.taskId) {
                try {
                  const status =
                    se.taskStatus === 'completed' ? 'completed' : 'error';
                  const summary = se.taskSummary?.slice(0, 2000);
                  let targetTaskId = se.taskId;
                  let existing = getAgent(targetTaskId);
                  if (!existing || existing.kind !== 'task') {
                    const fallbackTaskId = pickRunningTaskForNotification();
                    if (fallbackTaskId) {
                      targetTaskId = fallbackTaskId;
                      existing = getAgent(fallbackTaskId);
                      logger.debug(
                        {
                          chatJid,
                          sdkTaskId: se.taskId,
                          mappedTaskId: fallbackTaskId,
                        },
                        'Task notification ID fallback to running task',
                      );
                    }
                  }

                  if (!existing) {
                    createAgent({
                      id: targetTaskId,
                      group_folder: group.folder,
                      chat_jid: chatJid,
                      name: 'Task',
                      prompt: '',
                      status,
                      kind: 'task',
                      created_by: null,
                      created_at: new Date().toISOString(),
                      completed_at: new Date().toISOString(),
                      result_summary: summary || null,
                      last_im_jid: null,
                      spawned_from_jid: null,
                    });
                    broadcastAgentStatus(
                      chatJid,
                      targetTaskId,
                      status,
                      'Task',
                      '',
                      summary,
                      'task',
                    );
                  } else if (existing.kind === 'task') {
                    updateAgentStatus(existing.id, status, summary);
                    queryTaskIds.delete(existing.id);
                    broadcastAgentStatus(
                      chatJid,
                      existing.id,
                      status,
                      existing.name,
                      existing.prompt,
                      summary,
                      'task',
                    );
                  }
                } catch (err) {
                  logger.warn(
                    { err, taskId: se.taskId },
                    'Failed to persist task_notification to DB',
                  );
                }
              }

              if (se.eventType === 'usage' && se.usage) {
                try {
                  updateLatestMessageTokenUsage(
                    chatJid,
                    JSON.stringify(se.usage),
                    lastReplyMsgId,
                    se.usage.costUSD,
                  );
                  deps.writeUsageRecords({
                    userId: effectiveGroup.created_by || 'system',
                    groupFolder: effectiveGroup.folder,
                    messageId: lastReplyMsgId,
                    usage: se.usage,
                  });

                  logger.debug(
                    {
                      chatJid,
                      msgId: lastReplyMsgId,
                      costUSD: se.usage.costUSD,
                      inputTokens: se.usage.inputTokens,
                    },
                    'Token usage persisted',
                  );

                  const ownerGroup = deps.registeredGroups[chatJid];
                  if (ownerGroup?.created_by && se.usage.costUSD) {
                    try {
                      const effective = updateUsage(
                        ownerGroup.created_by,
                        se.usage.costUSD,
                        se.usage.inputTokens || 0,
                        se.usage.outputTokens || 0,
                      );
                      deductUsageCost(
                        ownerGroup.created_by,
                        se.usage.costUSD,
                        lastReplyMsgId || chatJid,
                        effective,
                      );
                      const owner = getUserById(ownerGroup.created_by);
                      if (owner && owner.role !== 'admin') {
                        const freshAccess = checkBillingAccessFresh(
                          ownerGroup.created_by,
                          owner.role,
                        );
                        if (freshAccess.usage) {
                          broadcastBillingUpdate(ownerGroup.created_by, {
                            ...freshAccess,
                          });
                        }
                      }
                    } catch (billingErr) {
                      logger.warn(
                        { err: billingErr, chatJid },
                        'Failed to update billing usage',
                      );
                    }
                  }
                } catch (err) {
                  logger.warn(
                    { err, chatJid },
                    'Failed to persist token usage',
                  );
                }
              }

              resetIdleTimer();
              return;
            }

            if (result.result) {
              const raw =
                typeof result.result === 'string'
                  ? result.result
                  : JSON.stringify(result.result);
              let text = stripAgentInternalTags(raw);
              if (
                result.sourceKind === 'overflow_partial' ||
                result.sourceKind === 'compact_partial'
              ) {
                text = buildOverflowPartialReply(text);
              }
              if (
                result.sourceKind === 'auto_continue' &&
                isSystemMaintenanceNoise(text)
              ) {
                logger.info(
                  { group: group.name, textLen: text.length },
                  'auto_continue output suppressed (system maintenance noise)',
                );
                return;
              }
              logger.info(
                { group: group.name },
                `Agent output: ${raw.slice(0, 200)}`,
              );
              if (text) {
                await deps.setTyping(chatJid, false);
                const localImagePaths = deps.extractLocalImImagePaths(
                  text,
                  effectiveGroup.folder,
                );

                let streamingCardHandledIM = false;
                if (streamingSession?.isActive()) {
                  try {
                    await streamingSession.complete(text);
                    streamingCardHandledIM = true;
                    imManager.clearAckReaction(chatJid);
                    logger.debug(
                      { chatJid },
                      'Streaming card completed with final text',
                    );
                  } catch (err) {
                    logger.warn(
                      { err, chatJid },
                      'Streaming card complete failed, falling back to static message',
                    );
                    await streamingSession
                      .abort('回复已通过消息发送')
                      .catch(() => {});
                  }
                }

                if (
                  streamingCardHandledIM &&
                  (result.sourceKind === 'compact_partial' ||
                    result.sourceKind === 'overflow_partial')
                ) {
                  unregisterStreamingSession(streamingSessionJid);
                  streamingAccumulatedText = '';
                  streamingAccumulatedThinking = '';
                  streamingSession = imManager.createStreamingSession(
                    streamingSessionJid,
                    makeOnCardCreated(streamingSessionJid),
                  );
                  if (streamingSession) {
                    registerStreamingSession(
                      streamingSessionJid,
                      streamingSession,
                    );
                    logger.debug(
                      { chatJid, sourceKind: result.sourceKind },
                      'Rebuilt streaming card after partial output',
                    );
                  }
                }

                const routeCleared = directImReply && replySourceImJid === null;
                const routeSwitchedAway =
                  directImReply &&
                  replySourceImJid !== null &&
                  replySourceImJid !== chatJid;
                const skipImSend =
                  (streamingCardHandledIM && directImReply) ||
                  routeSwitchedAway ||
                  routeCleared;
                const effectiveTurnId = result.turnId || lastProcessed.id;
                const turnIdForDb =
                  sentReply && effectiveTurnId === lastSavedTurnId
                    ? undefined
                    : effectiveTurnId;

                lastReplyMsgId = await deps.sendMessage(chatJid, text, {
                  sendToIM: directImReply && !skipImSend,
                  localImagePaths,
                  messageMeta: {
                    turnId: turnIdForDb,
                    sessionId: result.sessionId || activeSessionId,
                    sdkMessageUuid: result.sdkMessageUuid,
                    sourceKind: result.sourceKind || 'sdk_final',
                    finalizationReason:
                      result.finalizationReason || 'completed',
                  },
                });
                lastSavedTurnId = effectiveTurnId;

                if (replySourceImJid && replySourceImJid !== chatJid) {
                  if (!streamingCardHandledIM && !sentReply) {
                    deps.sendImWithFailTracking(
                      replySourceImJid,
                      text,
                      localImagePaths,
                    );
                  }
                }

                const webJid = chatJid.startsWith('web:')
                  ? chatJid
                  : `web:${effectiveGroup.folder}`;
                for (const [imJid, g] of Object.entries(
                  deps.registeredGroups,
                )) {
                  if (
                    g.target_main_jid !== webJid ||
                    imJid === chatJid ||
                    imJid === replySourceImJid
                  ) {
                    continue;
                  }
                  if (g.reply_policy !== 'mirror') continue;
                  if (getChannelType(imJid)) {
                    deps.sendImWithFailTracking(imJid, text, localImagePaths);
                  }
                }

                sentReply = true;
                clearStreamingSnapshot(chatJid);
                streamingAccumulatedText = '';
                streamingAccumulatedThinking = '';
                commitCursor();
              }
              resetIdleTimer();
            }

            if (result.status === 'error') {
              hadError = true;
              if (result.error) lastError = result.error;
            }
          } catch (err) {
            logger.error(
              { group: group.name, err },
              'onOutput callback failed',
            );
            hadError = true;
          }
        },
        imagesForAgent,
      );
    } finally {
      await deps.setTyping(chatJid, false);
      imManager.clearAckReaction(chatJid);
      if (idleTimer) clearTimeout(idleTimer);
      deps.activeRouteUpdaters.delete(effectiveGroup.folder);
      deps.clearActiveImReplyRoute(effectiveGroup.folder);

      const wasInterrupted = streamInterrupted && !sentReply;

      if (streamingSession) {
        if (streamingSession.isActive()) {
          if (hadError || !output || output.status === 'error') {
            await streamingSession.abort('处理出错').catch(() => {});
          } else if (wasInterrupted) {
            await streamingSession.abort('已中断').catch(() => {});
          } else {
            streamingSession.dispose();
          }
        }
        unregisterStreamingSession(streamingSessionJid);
      }

      const webJidForShutdownCheck = chatJid.startsWith('web:')
        ? chatJid
        : `web:${effectiveGroup.folder}`;
      const alreadySavedByShutdown =
        deps.shutdownSavedJids.has(chatJid) ||
        deps.shutdownSavedJids.has(webJidForShutdownCheck);

      if (wasInterrupted && !alreadySavedByShutdown) {
        const interruptedText = buildInterruptedReply(
          streamingAccumulatedText,
          streamingAccumulatedThinking,
        );
        try {
          lastReplyMsgId = await deps.sendMessage(chatJid, interruptedText, {
            sendToIM: false,
            messageMeta: {
              turnId: lastProcessed.id,
              sessionId: activeSessionId,
              sourceKind: 'interrupt_partial',
              finalizationReason: 'interrupted',
            },
          });
          sentReply = true;
          commitCursor();
        } catch (err) {
          logger.warn({ err, chatJid }, 'Failed to save interrupted text');
        }
      }

      if (
        !sentReply &&
        !alreadySavedByShutdown &&
        output?.status !== 'closed' &&
        streamingAccumulatedText.trim()
      ) {
        try {
          const partialReply = buildInterruptedReply(
            streamingAccumulatedText,
            streamingAccumulatedThinking,
          );
          lastReplyMsgId = await deps.sendMessage(chatJid, partialReply, {
            sendToIM: false,
            messageMeta: {
              turnId: lastProcessed.id,
              sessionId: activeSessionId,
              sourceKind: 'interrupt_partial',
              finalizationReason: 'error',
            },
          });
          sentReply = true;
          commitCursor();
        } catch (err) {
          logger.warn({ err, chatJid }, 'Failed to save overflow partial text');
        }
      }
    }

    if (!output) {
      if (sentReply) {
        commitCursor();
        return true;
      }
      return false;
    }

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
        { group: group.name, folder: group.folder, error: detail },
        'Unrecoverable transcript error, auto-resetting session',
      );

      await clearSessionRuntimeFiles(group.folder);

      try {
        deleteSession(group.folder);
        delete deps.sessions[group.folder];
      } catch (err) {
        logger.error(
          { folder: group.folder, err },
          'Failed to clear session state during auto-reset',
        );
      }

      deps.sendSystemMessage(
        chatJid,
        'context_reset',
        `会话已自动重置：${detail}`,
      );
      commitCursor();
      return true;
    }

    if (output.status === 'closed' && !sentReply) {
      logger.warn(
        { group: group.name, chatJid },
        'Container closed during query without reply, keeping cursor for retry',
      );
      return true;
    }

    const isErrorExit = output.status === 'error' || hadError;
    if (isErrorExit) {
      try {
        const runningAgents = getRunningTaskAgentsByChat(chatJid);
        const marked = markRunningTaskAgentsAsError(chatJid);
        if (marked > 0) {
          logger.info(
            { chatJid, marked },
            'Marked remaining running task agents as error',
          );
          for (const agent of runningAgents) {
            broadcastAgentStatus(
              chatJid,
              agent.id,
              'error',
              agent.name,
              agent.prompt,
              '容器超时或异常退出',
              agent.kind,
            );
          }
        }
      } catch (err) {
        logger.warn({ chatJid, err }, 'Failed to mark running task agents');
      }
    } else {
      try {
        let completed = 0;
        for (const taskId of queryTaskIds) {
          const agent = getAgent(taskId);
          if (
            !agent ||
            agent.kind !== 'task' ||
            agent.chat_jid !== chatJid ||
            agent.status !== 'running'
          ) {
            continue;
          }
          updateAgentStatus(
            taskId,
            'completed',
            agent.result_summary || '任务已完成',
          );
          broadcastAgentStatus(
            chatJid,
            taskId,
            'completed',
            agent.name,
            agent.prompt,
            agent.result_summary || '任务已完成',
            agent.kind,
          );
          completed += 1;
        }
        if (completed > 0) {
          logger.warn(
            { chatJid, completed },
            'Force-completed stale running task agents after successful query',
          );
        }
      } catch (err) {
        logger.warn(
          { chatJid, err },
          'Failed to force-complete stale running task agents',
        );
      }
    }

    if (isErrorExit && !sentReply) {
      const errorDetail = output.error || lastError || '未知错误';

      if (errorDetail.startsWith('context_overflow:')) {
        const overflowMsg = errorDetail.replace(/^context_overflow:\s*/, '');
        deps.sendSystemMessage(chatJid, 'context_overflow', overflowMsg);
        logger.warn(
          { group: group.name, error: overflowMsg },
          'Context overflow detected, skipping retry',
        );
        commitCursor();
        return true;
      }

      const isOom = deps.oomExitRe.test(errorDetail);
      if (isOom) {
        const folder = effectiveGroup.folder;
        deps.consecutiveOomExits[folder] =
          (deps.consecutiveOomExits[folder] || 0) + 1;
        setRouterState(
          `oom_exits:${folder}`,
          String(deps.consecutiveOomExits[folder]),
        );
        logger.warn(
          {
            folder,
            consecutive: deps.consecutiveOomExits[folder],
            threshold: deps.oomAutoResetThreshold,
          },
          'OOM exit detected (code 137)',
        );

        if (deps.consecutiveOomExits[folder] >= deps.oomAutoResetThreshold) {
          logger.warn(
            { folder, consecutive: deps.consecutiveOomExits[folder] },
            'Consecutive OOM threshold reached, auto-resetting session to break death loop',
          );
          deps.consecutiveOomExits[folder] = 0;
          deleteRouterState(`oom_exits:${folder}`);

          try {
            await clearSessionRuntimeFiles(folder);
          } catch (err) {
            logger.error(
              { folder, err },
              'Failed to clear session files during OOM auto-reset',
            );
          }
          try {
            deleteSession(folder);
            delete deps.sessions[folder];
          } catch (err) {
            logger.error(
              { folder, err },
              'Failed to clear session during OOM auto-reset',
            );
          }

          deps.sendSystemMessage(
            chatJid,
            'context_reset',
            '会话文件过大导致内存溢出（OOM），已自动重置会话。之前的对话上下文已清除，请重新描述您的需求。',
          );
          commitCursor();
          return true;
        }
      } else if (deps.consecutiveOomExits[effectiveGroup.folder]) {
        delete deps.consecutiveOomExits[effectiveGroup.folder];
        deleteRouterState(`oom_exits:${effectiveGroup.folder}`);
      }

      deps.sendSystemMessage(chatJid, 'agent_error', errorDetail);
      logger.warn(
        { group: group.name, error: errorDetail },
        'Agent error (no reply sent), keeping cursor at previous position for retry',
      );
      return false;
    }

    if (deps.consecutiveOomExits[effectiveGroup.folder]) {
      delete deps.consecutiveOomExits[effectiveGroup.folder];
      deleteRouterState(`oom_exits:${effectiveGroup.folder}`);
    }

    commitCursor();
    return true;
  }

  return { processGroupMessages };
}

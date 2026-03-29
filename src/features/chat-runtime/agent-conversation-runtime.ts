import { ChildProcess } from 'child_process';
import crypto from 'crypto';

import type {
  AvailableGroup,
  ContainerInput,
  ContainerOutput,
} from '../execution/container-runner.js';
import {
  runContainerAgent,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../execution/container-runner.js';
import { MAIN_GROUP_FOLDER } from '../../config.js';
import {
  deleteSession,
  ensureChatExists,
  getAgent,
  getAllRegisteredGroups,
  getAllTasks,
  getMessagesSince,
  getRuntimeSession,
  setSession,
  storeMessageDirect,
  updateAgentLastImJid,
  updateAgentStatus,
  updateLatestMessageTokenUsage,
} from '../../db.js';
import {
  registerMessageIdMapping,
  registerStreamingSession,
  unregisterStreamingSession,
} from '../im/channels/feishu/streaming-card/index.js';
import type { StreamingCardController } from '../im/channels/feishu/streaming-card/index.js';
import type { GroupQueue } from './group-queue.js';
import { feedStreamEventToCard } from './main-conversation-runtime.js';
import {
  EMPTY_CURSOR,
  buildInterruptedReply,
  buildOverflowPartialReply,
} from './recovery.js';
import { logger } from '../../logger.js';
import { getSystemSettings } from '../../runtime-config.js';
import { clearSessionRuntimeFiles } from './runtime-state-cleanup.js';
import type {
  AgentStatus,
  MessageCursor,
  RegisteredGroup,
  RuntimeType,
} from '../../types.js';
import {
  isSystemMaintenanceNoise,
  stripAgentInternalTags,
} from '../../utils.js';

interface AgentConversationRuntimeDeps {
  assistantName: string;
  registeredGroups: Record<string, RegisteredGroup>;
  lastAgentTimestamp: Record<string, MessageCursor>;
  advanceCursors: (jid: string, candidate: MessageCursor) => void;
  formatMessages: (messages: any[], isShared?: boolean) => string;
  collectMessageImages: (
    chatJid: string,
    messages: any[],
  ) => Array<{ data: string; mimeType: string }>;
  queue: Pick<GroupQueue, 'closeStdin' | 'registerProcess'>;
  getIpcRuntime: () => {
    watchGroup: (folder: string) => void;
    unwatchGroup: (folder: string) => void;
  };
  getAvailableGroups: () => AvailableGroup[];
  resolveEffectiveGroup: (group: RegisteredGroup) => {
    effectiveGroup: RegisteredGroup;
    isHome: boolean;
  };
  resolveOwnerHomeFolder: (group: RegisteredGroup) => string | undefined;
  extractLocalImImagePaths: (text: string, groupFolder?: string) => string[];
  sendImWithRetry: (
    imJid: string,
    text: string,
    localImagePaths: string[],
  ) => Promise<boolean>;
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
    usage: {
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
    };
  }) => void;
  getAgentReplyRouteJid: (
    folder: string,
    chatJid: string,
    agentId?: string,
  ) => string | undefined;
  getEffectiveRuntime: (group: RegisteredGroup) => RuntimeType;
  sendSystemMessage: (jid: string, type: string, detail: string) => void;
  broadcastStreamEvent: (jid: string, event: any, agentId?: string) => void;
  broadcastNewMessage: (
    jid: string,
    message: any,
    agentId?: string,
    source?: string,
  ) => void;
  broadcastAgentStatus: (
    chatJid: string,
    agentId: string,
    status: AgentStatus,
    name: string,
    prompt: string,
    resultSummary?: string,
  ) => void;
  imManager: {
    isChannelAvailableForJid: (jid: string) => boolean;
    createStreamingSession: (
      jid: string,
      onCardCreated?: (messageId: string) => void,
    ) => StreamingCardController | undefined;
  };
  getChannelType: (jid: string) => string | null;
}

export function createAgentConversationRuntime(
  deps: AgentConversationRuntimeDeps,
): {
  processAgentConversation: (chatJid: string, agentId: string) => Promise<void>;
} {
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

    let group = deps.registeredGroups[chatJid];
    if (!group) {
      Object.keys(deps.registeredGroups).forEach((key) => {
        delete deps.registeredGroups[key];
      });
      Object.assign(deps.registeredGroups, getAllRegisteredGroups());
      group = deps.registeredGroups[chatJid];
    }
    if (!group) return;

    const { effectiveGroup } = deps.resolveEffectiveGroup(group);

    const virtualChatJid = `${chatJid}#agent:${agentId}`;
    const virtualJid = virtualChatJid; // used as deps.queue key

    // Get pending messages
    const sinceCursor = deps.lastAgentTimestamp[virtualChatJid] || EMPTY_CURSOR;
    const missedMessages = getMessagesSince(virtualChatJid, sinceCursor);
    if (missedMessages.length === 0) {
      // Spawn agents are fire-and-forget: if no messages are found (race condition
      // or cursor already advanced), mark as error so they don't stay idle forever.
      if (agent.kind === 'spawn' && agent.status === 'idle') {
        updateAgentStatus(agentId, 'error', '未找到待处理消息');
        deps.broadcastAgentStatus(
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
    deps.broadcastAgentStatus(
      chatJid,
      agentId,
      'running',
      agent.name,
      agent.prompt,
    );

    const prompt = deps.formatMessages(missedMessages, false);
    const images = deps.collectMessageImages(virtualChatJid, missedMessages);
    const imagesForAgent = images.length > 0 ? images : undefined;
    // For agent conversations, route reply to IM based on the most recent
    // message's source.  Unlike the main conversation (#99), agent conversations
    // are explicitly bound to IM groups, so the user expects replies to go back
    // to the IM channel they last messaged from — even if older messages in
    // the batch originated from the web (e.g. after a /clear).
    let replySourceImJid: string | null = null;
    {
      const lastSourceJid =
        missedMessages[missedMessages.length - 1]?.source_jid;
      if (lastSourceJid && deps.getChannelType(lastSourceJid) !== null) {
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
        if (deps.imManager.isChannelAvailableForJid(agentRow.last_im_jid)) {
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
      ? deps.imManager.createStreamingSession(replySourceImJid, (messageId) =>
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
        deps.queue.closeStdin(virtualJid);
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
      deps.advanceCursors(virtualChatJid, {
        timestamp: lastProcessed.timestamp,
        id: lastProcessed.id,
      });
      cursorCommitted = true;
    };

    const runtime = deps.getEffectiveRuntime(effectiveGroup);
    const sessionRecord = getRuntimeSession(effectiveGroup.folder, agentId);
    const sessionId = sessionRecord?.sessionId;
    let currentAgentSessionId = sessionId;
    const replyRouteJid = deps.getAgentReplyRouteJid(
      effectiveGroup.folder,
      chatJid,
      agentId,
    );

    const wrappedOnOutput = async (output: ContainerOutput) => {
      // Track session
      if (output.newSessionId && output.status !== 'error') {
        setSession(effectiveGroup.folder, output.newSessionId, agentId);
        currentAgentSessionId = output.newSessionId;
      }

      // Stream events
      if (output.status === 'stream' && output.streamEvent) {
        deps.broadcastStreamEvent(chatJid, output.streamEvent, agentId);

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
            const interruptedText = buildInterruptedReply(
              agentStreamingAccText,
            );
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
                deps.assistantName,
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
              deps.broadcastNewMessage(
                virtualChatJid,
                {
                  id: persistedMsgId,
                  chat_jid: virtualChatJid,
                  sender: 'happypaw-agent',
                  sender_name: deps.assistantName,
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
            deps.writeUsageRecords({
              userId:
                effectiveGroup.created_by ||
                deps.registeredGroups[chatJid]?.created_by ||
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
        // Short acknowledgements ("OK", "已更新 AGENTS.md") that leak from the
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
            deps.assistantName,
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
          deps.broadcastNewMessage(
            virtualChatJid,
            {
              id: persistedMsgId,
              chat_jid: virtualChatJid,
              sender: 'happypaw-agent',
              sender_name: deps.assistantName,
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

          const localImagePaths = deps.extractLocalImImagePaths(
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
            agentStreamingSession = deps.imManager.createStreamingSession(
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
            const imSent = await deps.sendImWithRetry(
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
            if (
              isFirstReply &&
              deps.getChannelType(chatJid) === null &&
              replyRouteJid &&
              replyRouteJid !== chatJid
            ) {
              const imSent = await deps.sendImWithRetry(
                replyRouteJid,
                text,
                localImagePaths,
              );
              if (imSent) {
                logger.info(
                  {
                    chatJid,
                    agentId,
                    replyRouteJid,
                    sourceKind: output.sourceKind,
                    textLen: text.length,
                  },
                  'Agent conversation: static IM message sent via fallback route',
                );
              } else {
                logger.error(
                  {
                    chatJid,
                    agentId,
                    replyRouteJid,
                    sourceKind: output.sourceKind,
                  },
                  'Agent conversation: fallback IM send failed after all retries',
                );
              }
            } else {
              logger.debug(
                {
                  chatJid,
                  agentId,
                  sourceKind: output.sourceKind,
                  replyRouteJid,
                },
                'Agent conversation: no replySourceImJid, skip IM delivery',
              );
            }
          }

          // Optional mirror mode for linked IM channels
          for (const [imJid, g] of Object.entries(deps.registeredGroups)) {
            if (g.target_agent_id !== agentId || imJid === replySourceImJid)
              continue;
            if (g.reply_policy !== 'mirror') continue;
            if (deps.getChannelType(imJid))
              deps.sendImWithFailTracking(imJid, text, localImagePaths);
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
            deps.queue.closeStdin(virtualChatJid);
          }
        }
      }

      if (output.status === 'error') {
        hadError = true;
        if (output.error) lastError = output.error;
      }
    };

    deps.getIpcRuntime().watchGroup(effectiveGroup.folder);
    try {
      const executionMode = effectiveGroup.executionMode || 'container';
      const onProcessCb = (proc: ChildProcess, identifier: string) => {
        const containerName = executionMode === 'container' ? identifier : null;
        deps.queue.registerProcess(
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
        replyRouteJid,
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
      const availableGroups = deps.getAvailableGroups();
      writeGroupsSnapshot(
        effectiveGroup.folder,
        isAdminHome,
        availableGroups,
        new Set(Object.keys(deps.registeredGroups)),
      );

      const ownerHomeFolder = deps.resolveOwnerHomeFolder(effectiveGroup);

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
        setSession(effectiveGroup.folder, output.newSessionId, agentId);
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

        deps.sendSystemMessage(
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
            deps.assistantName,
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
          deps.broadcastNewMessage(
            virtualChatJid,
            {
              id: persistedMsgId,
              chat_jid: virtualChatJid,
              sender: 'happypaw-agent',
              sender_name: deps.assistantName,
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
            deps.assistantName,
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
          deps.broadcastNewMessage(
            virtualChatJid,
            {
              id: persistedMsgId,
              chat_jid: virtualChatJid,
              sender: 'happypaw-agent',
              sender_name: deps.assistantName,
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
            deps.assistantName,
            resultText,
            injectTs,
            true,
          );
          deps.broadcastNewMessage(agent.spawned_from_jid, {
            id: injectId,
            chat_jid: agent.spawned_from_jid,
            sender: 'happypaw-agent',
            sender_name: deps.assistantName,
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
      deps.broadcastAgentStatus(
        chatJid,
        agentId,
        endStatus,
        agent.name,
        agent.prompt,
        hadError ? lastError : undefined,
      );

      deps.getIpcRuntime().unwatchGroup(effectiveGroup.folder);
    }
  }

  return { processAgentConversation };
}

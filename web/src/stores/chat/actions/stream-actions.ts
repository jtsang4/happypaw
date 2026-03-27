import { api } from '../../../api/client';
import { notifyIfHidden, shouldEmitBackgroundTaskNotice, showToast } from '../../../utils/toast';
import {
  isInterruptSystemMessage,
  isTerminalSystemMessage,
  mergeMessagesChronologically,
  pickSdkTaskAliasTarget,
  resolveSdkTaskId,
  capThinkingCache,
} from '../helpers';
import {
  clearStreamingFromSession,
  restoreStreamingFromSession,
  saveStreamingToSession,
} from '../persistence';
import {
  clearSdkTaskStaleTimer,
  hasCompletedSdkTask,
  markSdkTaskCompleted,
  resetSdkTaskStaleTimer,
  scheduleSdkTaskCleanup,
} from '../sdk-tasks';
import {
  applyStreamEvent,
  buildRestoredStreamingState,
  clearPendingMainStreamDelta,
  flushPendingMainStreamDelta,
  queuePendingStreamDelta,
  resolveStreamingPrev,
} from '../streaming';
import { MAX_STREAMING_TEXT, SDK_TASK_AUTO_CLOSE_MS, SDK_TASK_TOOL_END_FALLBACK_CLOSE_MS } from '../constants';
import type { ChatState, ChatStoreGet, ChatStoreSet, Message, StreamSnapshotData, StreamingState } from '../types';

type StreamActions = Pick<
  ChatState,
  | 'handleStreamEvent'
  | 'handleWsNewMessage'
  | 'restoreActiveState'
  | 'handleStreamSnapshot'
  | 'handleRunnerState'
  | 'clearStreaming'
  | 'saveDraft'
  | 'clearDraft'
>;

export function createStreamActions(set: ChatStoreSet, get: ChatStoreGet): StreamActions {
  return {
    handleStreamEvent: (chatJid, event, agentId) => {
      if (get().clearing[chatJid]) return;

      if (queuePendingStreamDelta(chatJid, event, agentId, set)) {
        return;
      }

      if (agentId) {
        if (event.eventType === 'status' && event.statusText === 'interrupted') {
          set((s) => {
            const nextStreaming = { ...s.agentStreaming };
            delete nextStreaming[agentId];
            const nextWaiting = { ...s.agentWaiting };
            delete nextWaiting[agentId];
            return { agentStreaming: nextStreaming, agentWaiting: nextWaiting };
          });
          return;
        }
        set((s) => {
          if (!s.agentStreaming[agentId] && s.agentWaiting[agentId] === false) {
            return s;
          }
          const prev = resolveStreamingPrev(s.agentStreaming[agentId], event);
          const next = { ...prev };
          applyStreamEvent(event, prev, next, MAX_STREAMING_TEXT);
          return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
        });
        return;
      }

      const ensureSdkTask = (taskId: string, description?: string, isTeammate?: boolean) => {
        set((s) => {
          const existingTask = s.sdkTasks[taskId];
          const desc = description || existingTask?.description || 'Task';
          const teammate = isTeammate || existingTask?.isTeammate || false;

          return {
            sdkTasks: {
              ...s.sdkTasks,
              [taskId]: {
                chatJid,
                description: desc,
                status: 'running' as const,
                summary: existingTask?.summary,
                startedAt: existingTask?.startedAt || Date.now(),
                ...(teammate ? { isTeammate: true } : {}),
              },
            },
          };
        });
        if (!isTeammate) {
          resetSdkTaskStaleTimer(set, get, taskId, chatJid);
        }
      };

      const resolveOrBindTaskId = (rawId: string): string => {
        const state = get();
        const resolved = resolveSdkTaskId(state, rawId);
        if (state.sdkTasks[resolved]) return resolved;
        const target = pickSdkTaskAliasTarget(state, chatJid);
        if (target && rawId !== target) {
          set((s) => ({ sdkTaskAliases: { ...s.sdkTaskAliases, [rawId]: target } }));
          return target;
        }
        return resolved;
      };

      const finalizeSdkTask = (
        taskId: string,
        status: 'completed' | 'error',
        summary?: string,
        closeAfterMs = SDK_TASK_AUTO_CLOSE_MS,
      ) => {
        clearSdkTaskStaleTimer(taskId);
        markSdkTaskCompleted(taskId);
        let targetChatJid: string | null = null;
        set((s) => {
          const existingTask = s.sdkTasks[taskId];
          if (!existingTask) return {};
          const taskChatJid = existingTask.chatJid || chatJid;
          targetChatJid = taskChatJid;
          return {
            sdkTasks: {
              ...s.sdkTasks,
              [taskId]: {
                chatJid: taskChatJid,
                description: existingTask.description,
                status,
                summary: summary ?? existingTask.summary,
                ...(existingTask.isTeammate ? { isTeammate: true } : {}),
              },
            },
          };
        });
        if (targetChatJid) {
          scheduleSdkTaskCleanup(set, taskId, targetChatJid, closeAfterMs);
        }
      };

      if (
        (event.eventType === 'task_start' && event.toolUseId)
        || (event.eventType === 'tool_use_start' && event.toolName === 'Task' && event.toolUseId)
      ) {
        ensureSdkTask(
          event.toolUseId!,
          event.taskDescription || event.toolInputSummary,
          event.isTeammate,
        );
      }

      if (event.eventType === 'task_notification' && event.taskId) {
        const resolvedTaskId = resolveOrBindTaskId(event.taskId);
        finalizeSdkTask(
          resolvedTaskId,
          event.taskStatus === 'completed' ? 'completed' : 'error',
          event.taskSummary,
        );

        if (event.isBackground && shouldEmitBackgroundTaskNotice(resolvedTaskId)) {
          const taskInfo = get().sdkTasks[resolvedTaskId];
          const desc = (taskInfo?.description || event.taskSummary || '后台任务').slice(0, 60);
          const status = event.taskStatus === 'completed' ? '已完成' : '失败';
          if (typeof document === 'undefined' || !document.hidden) {
            showToast(`${desc} ${status}`, event.taskSummary);
          }
          notifyIfHidden(`HappyPaw: ${desc} ${status}`, event.taskSummary);
        }

        return;
      }

      if (event.parentToolUseId) {
        const tid = resolveOrBindTaskId(event.parentToolUseId);
        const state = get();
        const knownTask = !!state.sdkTasks[tid];
        if (knownTask) {
          if (hasCompletedSdkTask(tid)) return;
          const task = state.sdkTasks[tid];
          if (task && !task.isTeammate) {
            resetSdkTaskStaleTimer(set, get, tid, chatJid);
          }
        }
      }

      if (event.eventType === 'tool_use_end' && event.toolUseId) {
        const resolvedToolUseId = resolveOrBindTaskId(event.toolUseId);
        const task = get().sdkTasks[resolvedToolUseId];
        if (task && task.status === 'running') {
          finalizeSdkTask(resolvedToolUseId, 'completed', task.summary, SDK_TASK_TOOL_END_FALLBACK_CLOSE_MS);
        }
      }

      if (event.eventType === 'status' && event.statusText === 'interrupted') {
        flushPendingMainStreamDelta(chatJid, set);
        set((s) => {
          const streamState = s.streaming[chatJid];
          const nextStreaming = { ...s.streaming };

          const hasData = streamState && (
            streamState.partialText ||
            streamState.thinkingText ||
            streamState.activeTools.length > 0 ||
            streamState.activeHook ||
            streamState.systemStatus ||
            streamState.recentEvents.length > 0 ||
            (streamState.todos && streamState.todos.length > 0)
          );

          if (hasData) {
            nextStreaming[chatJid] = {
              ...streamState,
              isThinking: false,
              activeTools: [],
              activeHook: null,
              systemStatus: null,
              interrupted: true,
            };
          } else {
            delete nextStreaming[chatJid];
          }

          const nextPendingThinking = { ...s.pendingThinking };
          delete nextPendingThinking[chatJid];

          return {
            waiting: { ...s.waiting, [chatJid]: false },
            streaming: nextStreaming,
            pendingThinking: nextPendingThinking,
          };
        });

        setTimeout(() => {
          const state = get();
          if (state.streaming[chatJid] && !state.waiting[chatJid]) {
            set((s) => {
              const next = { ...s.streaming };
              delete next[chatJid];
              return { streaming: next };
            });
          }
        }, 10_000);

        return;
      }

      if (event.eventType === 'usage' && event.usage) {
        const usage = event.usage;
        const tokenUsageJson = JSON.stringify({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          costUSD: usage.costUSD,
          durationMs: usage.durationMs,
          numTurns: usage.numTurns,
          modelUsage: usage.modelUsage,
        });
        set((s) => {
          const msgs = s.messages[chatJid];
          if (!msgs || msgs.length === 0) return s;
          let targetIdx = -1;
          if (event.turnId) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (
                msgs[i].is_from_me &&
                msgs[i].turn_id === event.turnId &&
                msgs[i].source_kind !== 'sdk_send_message'
              ) {
                targetIdx = i;
                break;
              }
            }
          }
          if (targetIdx < 0) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (
                msgs[i].is_from_me &&
                msgs[i].source_kind !== 'sdk_send_message'
              ) {
                targetIdx = i;
                break;
              }
            }
          }
          if (targetIdx < 0) return s;
          const updated = [...msgs];
          updated[targetIdx] = { ...updated[targetIdx], token_usage: tokenUsageJson };
          return { messages: { ...s.messages, [chatJid]: updated } };
        });
      }

      set((s) => {
        if (!s.streaming[chatJid] && s.waiting[chatJid] === false) {
          return s;
        }
        if (s.streaming[chatJid]?.interrupted) {
          return s;
        }
        const prev = resolveStreamingPrev(s.streaming[chatJid], event);
        const next = { ...prev };
        applyStreamEvent(event, prev, next, MAX_STREAMING_TEXT);
        saveStreamingToSession(chatJid, next);
        return {
          waiting: { ...s.waiting, [chatJid]: true },
          streaming: { ...s.streaming, [chatJid]: next },
        };
      });
    },

    handleWsNewMessage: (chatJid, wsMsg, agentId, source) => {
      if (!wsMsg || !wsMsg.id) return;
      if (get().clearing[chatJid]) return;

      const msg: Message = {
        id: wsMsg.id,
        chat_jid: wsMsg.chat_jid || chatJid,
        sender: wsMsg.sender || '',
        sender_name: wsMsg.sender_name || '',
        content: wsMsg.content || '',
        timestamp: wsMsg.timestamp || new Date().toISOString(),
        is_from_me: wsMsg.is_from_me ?? false,
        attachments: wsMsg.attachments,
        token_usage: wsMsg.token_usage,
        turn_id: wsMsg.turn_id ?? null,
        session_id: wsMsg.session_id ?? null,
        sdk_message_uuid: wsMsg.sdk_message_uuid ?? null,
        source_kind: wsMsg.source_kind ?? null,
        finalization_reason: wsMsg.finalization_reason ?? null,
      };

      if (agentId) {
        set((s) => {
          const existing = s.agentMessages[agentId] || [];
          const updated = mergeMessagesChronologically(existing, [msg]);
          const isAgentReply =
            msg.is_from_me &&
            msg.sender !== '__system__' &&
            msg.source_kind !== 'sdk_send_message';

          const nextAgentStreaming = isAgentReply
            ? (() => {
                const n = { ...s.agentStreaming };
                delete n[agentId];
                return n;
              })()
            : s.agentStreaming;

          const nextAgentWaiting = isAgentReply
            ? { ...s.agentWaiting, [agentId]: false }
            : !msg.is_from_me
              ? { ...s.agentWaiting, [agentId]: true }
              : s.agentWaiting;

          return {
            agentMessages: { ...s.agentMessages, [agentId]: updated },
            agentWaiting: nextAgentWaiting,
            agentStreaming: nextAgentStreaming,
          };
        });
        return;
      }

      set((s) => {
        const existing = s.messages[chatJid] || [];
        const updated = mergeMessagesChronologically(existing, [msg]);

        const isAgentReply =
          msg.is_from_me &&
          msg.sender !== '__system__' &&
          source !== 'scheduled_task' &&
          msg.source_kind !== 'sdk_send_message';
        const isSystemError = isTerminalSystemMessage(msg);
        const interruptPartialWhileFrozen =
          msg.source_kind === 'interrupt_partial' && s.streaming[chatJid]?.interrupted;
        const shouldFinalizeAssistant =
          isAgentReply &&
          !interruptPartialWhileFrozen &&
          (msg.source_kind === 'sdk_final'
            || msg.source_kind === 'interrupt_partial'
            || msg.source_kind === null
            || msg.source_kind === undefined
            || msg.source_kind === 'legacy');

        if (shouldFinalizeAssistant || isSystemError) {
          const streamState = s.streaming[chatJid];
          const thinkingText = isAgentReply
            ? (streamState?.thinkingText || s.pendingThinking[chatJid])
            : undefined;
          const nextStreaming = { ...s.streaming };
          delete nextStreaming[chatJid];
          const nextPending = { ...s.pendingThinking };
          delete nextPending[chatJid];

          return {
            messages: { ...s.messages, [chatJid]: updated },
            waiting: { ...s.waiting, [chatJid]: false },
            streaming: nextStreaming,
            pendingThinking: nextPending,
            ...(thinkingText ? { thinkingCache: capThinkingCache({ ...s.thinkingCache, [msg.id]: thinkingText }) } : {}),
          };
        }

        return {
          messages: { ...s.messages, [chatJid]: updated },
        };
      });

      if (isInterruptSystemMessage(msg) && get().streaming[chatJid]) {
        setTimeout(() => {
          const state = get();
          if (state.streaming[chatJid] && !state.waiting[chatJid]) {
            set((s) => {
              const next = { ...s.streaming };
              delete next[chatJid];
              return { streaming: next };
            });
          }
        }, 20_000);
      }
    },

    restoreActiveState: async () => {
      try {
        const data = await api.get<{ groups: Array<{ jid: string; active: boolean; pendingMessages?: boolean }> }>('/api/status');
        set((s) => {
          const nextWaiting = { ...s.waiting };
          const nextStreaming = { ...s.streaming };
          const knownJids = new Set(data.groups.map((g) => g.jid));

          for (const jid of Object.keys(nextWaiting)) {
            if (!knownJids.has(jid)) {
              delete nextWaiting[jid];
              delete nextStreaming[jid];
              clearStreamingFromSession(jid);
            }
          }

          for (const g of data.groups) {
            if (g.pendingMessages) {
              nextWaiting[g.jid] = true;
              continue;
            }
            if (!g.active) {
              delete nextWaiting[g.jid];
              delete nextStreaming[g.jid];
              clearStreamingFromSession(g.jid);
              continue;
            }
            const msgs = s.messages[g.jid] || [];
            const latest = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            const inferredWaiting =
              !!latest &&
              latest.sender !== '__system__' &&
              (latest.is_from_me === false || latest.source_kind === 'sdk_send_message');
            if (inferredWaiting) {
              nextWaiting[g.jid] = true;
              if (!nextStreaming[g.jid]) {
                const restored = restoreStreamingFromSession(g.jid);
                if (restored) {
                  nextStreaming[g.jid] = restored;
                }
              }
            } else {
              delete nextWaiting[g.jid];
              clearStreamingFromSession(g.jid);
            }
          }
          return { waiting: nextWaiting, streaming: nextStreaming };
        });
      } catch {
        // 静默失败
      }
    },

    handleStreamSnapshot: (chatJid, snapshot: StreamSnapshotData, agentId) => {
      const restored: StreamingState = buildRestoredStreamingState({
        partialText: snapshot.partialText || '',
        activeTools: snapshot.activeTools || [],
        recentEvents: snapshot.recentEvents as StreamingState['recentEvents'],
        todos: snapshot.todos,
        systemStatus: snapshot.systemStatus || null,
        turnId: snapshot.turnId,
      });

      if (agentId) {
        set((s) => {
          if (s.agentStreaming[agentId]?.partialText) return s;
          return {
            agentWaiting: { ...s.agentWaiting, [agentId]: true },
            agentStreaming: { ...s.agentStreaming, [agentId]: restored },
          };
        });
        return;
      }

      set((s) => {
        if (s.streaming[chatJid]?.partialText) return s;
        return {
          waiting: { ...s.waiting, [chatJid]: true },
          streaming: { ...s.streaming, [chatJid]: restored },
        };
      });
    },

    handleRunnerState: (chatJid, state) => {
      if (state === 'idle') {
        if (get().streaming[chatJid]?.interrupted) return;
        get().clearStreaming(chatJid);

        const currentAgents = get().agents[chatJid] || [];
        const hasTaskAgents = currentAgents.some((a) => a.kind === 'task');
        if (hasTaskAgents) {
          set((s) => {
            const existing = s.agents[chatJid] || [];
            const filtered = existing.filter((a) => a.kind !== 'task');
            return { agents: { ...s.agents, [chatJid]: filtered } };
          });
        }
      } else if (state === 'running') {
        set((s) => {
          const nextStreaming = { ...s.streaming };
          if (nextStreaming[chatJid]?.interrupted) {
            delete nextStreaming[chatJid];
          }
          return {
            waiting: { ...s.waiting, [chatJid]: true },
            streaming: nextStreaming,
          };
        });
      }
    },

    clearStreaming: (chatJid, options) => {
      clearPendingMainStreamDelta(chatJid);
      clearStreamingFromSession(chatJid);
      set((s) => {
        const next = { ...s.streaming };
        const thinkingText = next[chatJid]?.thinkingText;
        const preserveThinking = options?.preserveThinking !== false;
        const nextPendingThinking = { ...s.pendingThinking };
        delete next[chatJid];
        if (preserveThinking && thinkingText) {
          nextPendingThinking[chatJid] = thinkingText;
        } else {
          delete nextPendingThinking[chatJid];
        }

        const runningSet = new Set<string>();
        for (const [taskId, task] of Object.entries(s.sdkTasks)) {
          if (task.chatJid === chatJid && task.status === 'running') {
            runningSet.add(taskId);
          }
        }

        const nextAgentStreaming = { ...s.agentStreaming };
        let agentStreamingChanged = false;
        for (const [taskId, task] of Object.entries(s.sdkTasks)) {
          if (task.chatJid === chatJid && !runningSet.has(taskId) && nextAgentStreaming[taskId]) {
            delete nextAgentStreaming[taskId];
            agentStreamingChanged = true;
          }
        }
        for (const agent of (s.agents[chatJid] || [])) {
          if (agent.status !== 'running' && nextAgentStreaming[agent.id]) {
            delete nextAgentStreaming[agent.id];
            agentStreamingChanged = true;
          }
        }

        return {
          waiting: { ...s.waiting, [chatJid]: false },
          streaming: next,
          pendingThinking: nextPendingThinking,
          ...(agentStreamingChanged ? { agentStreaming: nextAgentStreaming } : {}),
        };
      });
    },

    saveDraft: (jid, text) => {
      set((s) => {
        if (text) {
          if (s.drafts[jid] === text) return s;
          return { drafts: { ...s.drafts, [jid]: text } };
        }
        if (!(jid in s.drafts)) return s;
        const next = { ...s.drafts };
        delete next[jid];
        return { drafts: next };
      });
    },

    clearDraft: (jid) => {
      set((s) => {
        if (!(jid in s.drafts)) return s;
        const next = { ...s.drafts };
        delete next[jid];
        return { drafts: next };
      });
    },
  };
}

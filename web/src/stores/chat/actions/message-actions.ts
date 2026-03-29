import { api } from '../../../api/client.ts';
import { useAuthStore } from '../../auth.ts';
import { useFileStore } from '../../files.ts';
import {
  capThinkingCache,
  isTerminalSystemMessage,
  mergeMessagesChronologically,
  retainThinkingCacheForMessages,
} from '../helpers.ts';
import type { ChatState, ChatStoreGet, ChatStoreSet, Message } from '../types.ts';

type MessageActions = Pick<
  ChatState,
  | 'loadMessages'
  | 'refreshMessages'
  | 'sendMessage'
  | 'stopGroup'
  | 'interruptQuery'
  | 'resetSession'
  | 'clearHistory'
  | 'deleteMessage'
>;

export function createMessageActions(set: ChatStoreSet, get: ChatStoreGet): MessageActions {
  return {
    loadMessages: async (jid: string, loadMore = false) => {
      const state = get();
      const existing = state.messages[jid] || [];
      const before = loadMore && existing.length > 0 ? existing[0].timestamp : undefined;

      try {
        const data = await api.get<{ messages: Message[]; hasMore: boolean }>(
          `/api/groups/${encodeURIComponent(jid)}/messages?${new URLSearchParams(
            before ? { before: String(before), limit: '50' } : { limit: '50' },
          )}`,
        );
        const sorted = [...data.messages].reverse();
        set((s) => {
          const merged = mergeMessagesChronologically(s.messages[jid] || [], sorted);
          const latest = merged.length > 0 ? merged[merged.length - 1] : null;
          const shouldWait =
            !!latest &&
            latest.sender !== '__system__' &&
            (latest.is_from_me === false || latest.source_kind === 'sdk_send_message');
          const nextWaiting = { ...s.waiting };
          if (shouldWait) {
            nextWaiting[jid] = true;
          } else {
            delete nextWaiting[jid];
          }

          return {
            messages: {
              ...s.messages,
              [jid]: merged,
            },
            waiting: nextWaiting,
            hasMore: { ...s.hasMore, [jid]: data.hasMore },
            error: null,
          };
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    refreshMessages: async (jid: string) => {
      if (get().clearing[jid]) return;

      const state = get();
      const existing = state.messages[jid] || [];
      const lastTs = existing.length > 0 ? existing[existing.length - 1].timestamp : undefined;

      try {
        const params = new URLSearchParams({ limit: '50' });
        if (lastTs) params.set('after', lastTs);

        const data = await api.get<{ messages: Message[] }>(
          `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
        );

        if (get().clearing[jid]) return;

        if (data.messages.length > 0) {
          set((s) => {
            const merged = mergeMessagesChronologically(
              s.messages[jid] || [],
              data.messages,
            );
            const isFrozen = !!s.streaming[jid]?.interrupted;
            const agentReplied = data.messages.some(
              (m) =>
                m.is_from_me &&
                m.sender !== '__system__' &&
                m.source_kind !== 'sdk_send_message' &&
                !(isFrozen && m.source_kind === 'interrupt_partial'),
            );
            const hasSystemError = data.messages.some((m) => isTerminalSystemMessage(m));

            let nextThinkingCache = s.thinkingCache;
            let nextPendingThinking = s.pendingThinking;
            if (agentReplied && s.pendingThinking[jid]) {
              const lastAiMsg = [...data.messages]
                .reverse()
                .find(
                  (m) =>
                    m.is_from_me &&
                    m.sender !== '__system__' &&
                    m.source_kind !== 'sdk_send_message',
                );
              if (lastAiMsg) {
                nextThinkingCache = capThinkingCache({ ...s.thinkingCache, [lastAiMsg.id]: s.pendingThinking[jid] });
                const { [jid]: _, ...restPending } = s.pendingThinking;
                nextPendingThinking = restPending;
              }
            }

            return {
              messages: { ...s.messages, [jid]: merged },
              waiting: (agentReplied || hasSystemError)
                ? { ...s.waiting, [jid]: false }
                : s.waiting,
              streaming: (agentReplied || hasSystemError)
                ? (() => {
                    const next = { ...s.streaming };
                    delete next[jid];
                    return next;
                  })()
                : s.streaming,
              thinkingCache: nextThinkingCache,
              pendingThinking: nextPendingThinking,
              error: null,
            };
          });
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    sendMessage: async (jid: string, content: string, attachments) => {
      try {
        const body: {
          chatJid: string;
          content: string;
          attachments?: Array<{ type: 'image'; data: string; mimeType: string }>;
        } = { chatJid: jid, content };
        if (attachments && attachments.length > 0) {
          body.attachments = attachments.map((att) => ({ type: 'image', ...att }));
        }

        const data = await api.post<{ success: boolean; messageId: string; timestamp: string }>('/api/messages', body);
        if (data.success) {
          const authState = useAuthStore.getState();
          const sender = authState.user?.id || 'web-user';
          const senderName = authState.user?.display_name || authState.user?.username || 'Web';
          const msg: Message = {
            id: data.messageId,
            chat_jid: jid,
            sender,
            sender_name: senderName,
            content,
            timestamp: data.timestamp,
            is_from_me: false,
            attachments: body.attachments ? JSON.stringify(body.attachments) : undefined,
          };
          set((s) => {
            const existing = s.messages[jid] || [];
            if (!s.messages[jid]) {
              console.warn('[sendMessage] messages[jid] is undefined at send time', { jid, storeKeys: Object.keys(s.messages) });
            }
            const merged = mergeMessagesChronologically(existing, [msg]);
            const latest = merged.length > 0 ? merged[merged.length - 1] : null;
            const shouldWait =
              !!latest &&
              latest.is_from_me === false &&
              !isTerminalSystemMessage(latest);
            return {
              messages: {
                ...s.messages,
                [jid]: merged,
              },
              waiting: { ...s.waiting, [jid]: shouldWait },
              error: null,
            };
          });
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    stopGroup: async (jid: string) => {
      try {
        await api.post<{ success: boolean }>(
          `/api/groups/${encodeURIComponent(jid)}/stop`,
        );
        get().clearStreaming(jid, { preserveThinking: false });
        set((s) => {
          const next = { ...s.waiting };
          delete next[jid];
          return { waiting: next };
        });
        return true;
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },

    interruptQuery: async (jid: string) => {
      try {
        const data = await api.post<{ success: boolean; interrupted: boolean }>(
          `/api/groups/${encodeURIComponent(jid)}/interrupt`,
        );
        if (!data.interrupted) {
          set({ error: 'No active query to interrupt' });
          return false;
        }

        return true;
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },

    resetSession: async (jid: string, agentId?: string) => {
      try {
        await api.post<{ success: boolean; dividerMessageId: string }>(
          `/api/groups/${encodeURIComponent(jid)}/reset-session`,
          agentId ? { agentId } : undefined,
        );
        if (agentId) {
          set((s) => {
            const nextStreaming = { ...s.agentStreaming };
            delete nextStreaming[agentId];
            const nextWaiting = { ...s.agentWaiting };
            delete nextWaiting[agentId];
            return { agentStreaming: nextStreaming, agentWaiting: nextWaiting };
          });
          await get().loadAgentMessages(jid, agentId);
        } else {
          get().clearStreaming(jid, { preserveThinking: false });
          await get().refreshMessages(jid);
        }
        return true;
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },

    clearHistory: async (jid: string) => {
      set((s) => ({ clearing: { ...s.clearing, [jid]: true } }));

      try {
        await api.post<{ success: boolean }>(
          `/api/groups/${encodeURIComponent(jid)}/clear-history`,
        );

        set((s) => {
          const nextMessages = { ...s.messages };
          delete nextMessages[jid];
          const nextStreaming = { ...s.streaming };
          delete nextStreaming[jid];
          const { [jid]: _pending, ...nextPendingThinking } = s.pendingThinking;
          const { [jid]: _clearing, ...nextClearing } = s.clearing;

          return {
            messages: nextMessages,
            waiting: { ...s.waiting, [jid]: false },
            hasMore: { ...s.hasMore, [jid]: false },
            streaming: nextStreaming,
            pendingThinking: nextPendingThinking,
            clearing: nextClearing,
            thinkingCache: retainThinkingCacheForMessages(
              nextMessages,
              s.thinkingCache,
            ),
            error: null,
          };
        });

        await get().loadGroups();
        useFileStore.getState().loadFiles(jid);
        return true;
      } catch (err) {
        set((s) => {
          const { [jid]: _, ...nextClearing } = s.clearing;
          return { clearing: nextClearing, error: err instanceof Error ? err.message : String(err) };
        });
        return false;
      }
    },

    deleteMessage: async (jid: string, messageId: string) => {
      try {
        await api.delete(`/api/groups/${encodeURIComponent(jid)}/messages/${encodeURIComponent(messageId)}`);
        set((s) => ({
          messages: {
            ...s.messages,
            [jid]: (s.messages[jid] || []).filter((m) => m.id !== messageId),
          },
        }));
        return true;
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },
  };
}

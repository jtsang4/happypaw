import { api } from '../../../api/client';
import { retainThinkingCacheForMessages } from '../helpers';
import type { ChatState, ChatStoreGet, ChatStoreSet, CreateFlowOptions, GroupInfo } from '../types';

type GroupActions = Pick<
  ChatState,
  | 'loadGroups'
  | 'selectGroup'
  | 'createFlow'
  | 'renameFlow'
  | 'togglePin'
  | 'deleteFlow'
>;

export function createGroupActions(set: ChatStoreSet, get: ChatStoreGet): GroupActions {
  return {
    loadGroups: async () => {
      set({ loading: true });
      try {
        const data = await api.get<{ groups: Record<string, GroupInfo> }>('/api/groups');
        set((state) => {
          const currentStillExists =
            state.currentGroup && !!data.groups[state.currentGroup];

          let nextCurrent = currentStillExists ? state.currentGroup : null;
          if (!nextCurrent) {
            const homeEntry = Object.entries(data.groups).find(
              ([_, group]) => group.is_my_home,
            );
            if (homeEntry) {
              nextCurrent = homeEntry[0];
            } else {
              nextCurrent = Object.keys(data.groups)[0] || null;
            }
          }

          return {
            groups: data.groups,
            currentGroup: nextCurrent,
            loading: false,
            error: null,
          };
        });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    selectGroup: (jid: string) => {
      set({ currentGroup: jid });
      const state = get();
      if (!state.messages[jid]) {
        void get().loadMessages(jid);
      }
    },

    createFlow: async (name: string, options?: CreateFlowOptions) => {
      try {
        const body: Record<string, string> = { name };
        if (options?.execution_mode) body.execution_mode = options.execution_mode;
        if (options?.custom_cwd) body.custom_cwd = options.custom_cwd;
        if (options?.init_source_path) body.init_source_path = options.init_source_path;
        if (options?.init_git_url) body.init_git_url = options.init_git_url;

        const needsLongTimeout = !!(options?.init_source_path || options?.init_git_url);
        const data = await api.post<{
          success: boolean;
          jid: string;
          group: GroupInfo;
        }>('/api/groups', body, needsLongTimeout ? 120_000 : undefined);
        if (!data.success) return null;

        set((s) => ({
          groups: { ...s.groups, [data.jid]: data.group },
          error: null,
        }));

        return { jid: data.jid, folder: data.group.folder };
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },

    renameFlow: async (jid: string, name: string) => {
      try {
        await api.patch<{ success: boolean }>(`/api/groups/${encodeURIComponent(jid)}`, { name });
        set((s) => {
          const group = s.groups[jid];
          if (!group) return s;
          return {
            groups: {
              ...s.groups,
              [jid]: {
                ...group,
                name,
              },
            },
            error: null,
          };
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    togglePin: async (jid: string) => {
      const group = get().groups[jid];
      if (!group) return;
      const willPin = !group.pinned_at;
      try {
        const data = await api.patch<{ success: boolean; pinned_at?: string }>(
          `/api/groups/${encodeURIComponent(jid)}`,
          { is_pinned: willPin },
        );
        set((s) => {
          const g = s.groups[jid];
          if (!g) return s;
          return {
            groups: {
              ...s.groups,
              [jid]: {
                ...g,
                pinned_at: willPin ? (data.pinned_at || new Date().toISOString()) : undefined,
              },
            },
          };
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    deleteFlow: async (jid: string) => {
      try {
        await api.delete<{ success: boolean }>(`/api/groups/${encodeURIComponent(jid)}`);
        set((s) => {
          const nextGroups = { ...s.groups };
          const nextMessages = { ...s.messages };
          const nextWaiting = { ...s.waiting };
          const nextHasMore = { ...s.hasMore };
          const nextStreaming = { ...s.streaming };
          const nextPendingThinking = { ...s.pendingThinking };

          delete nextGroups[jid];
          delete nextMessages[jid];
          delete nextWaiting[jid];
          delete nextHasMore[jid];
          delete nextStreaming[jid];
          delete nextPendingThinking[jid];

          let nextCurrent = s.currentGroup === jid ? null : s.currentGroup;
          if (nextCurrent === null) {
            const remainingJids = Object.keys(nextGroups);
            nextCurrent = remainingJids.length > 0 ? remainingJids[0] : null;
          }

          return {
            groups: nextGroups,
            messages: nextMessages,
            waiting: nextWaiting,
            hasMore: nextHasMore,
            streaming: nextStreaming,
            pendingThinking: nextPendingThinking,
            thinkingCache: retainThinkingCacheForMessages(
              nextMessages,
              s.thinkingCache,
            ),
            currentGroup: nextCurrent,
            error: null,
          };
        });
      } catch (err: unknown) {
        const apiErr = err as { status?: number; body?: Record<string, unknown>; message?: string };
        if (apiErr.status === 409 && apiErr.body?.bound_agents) {
          const e = new Error(apiErr.message || 'IM binding conflict') as Error & { boundAgents: unknown };
          e.boundAgents = apiErr.body.bound_agents;
          throw e;
        }
        set({ error: apiErr.message || (err instanceof Error ? err.message : String(err)) });
      }
    },
  };
}

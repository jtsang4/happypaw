import { api } from '../../../api/client';
import { wsManager } from '../../../api/ws';
import { showToast } from '../../../utils/toast';
import {
  clearDbTaskAgentCleanupTimer,
  clearSdkTaskCleanupTimer,
  clearSdkTaskStaleTimer,
  markSdkTaskCompleted,
  scheduleDbTaskAgentCleanup,
} from '../sdk-tasks';
import { removeSdkTaskAliases, mergeMessagesChronologically } from '../helpers';
import { persistActiveAgentTabSelection } from '../persistence';
import type { AgentInfo } from '../../../types';
import type { ChatState, ChatStoreGet, ChatStoreSet } from '../types';

type AgentActions = Pick<
  ChatState,
  | 'handleAgentStatus'
  | 'loadAgents'
  | 'deleteAgentAction'
  | 'setActiveAgentTab'
  | 'createConversation'
  | 'renameConversation'
  | 'loadAgentMessages'
  | 'sendAgentMessage'
  | 'refreshAgentMessages'
>;

export function createAgentActions(set: ChatStoreSet, get: ChatStoreGet): AgentActions {
  return {
    handleAgentStatus: (chatJid, agentId, status, name, prompt, resultSummary, kind) => {
      set((s) => {
        const existing = s.agents[chatJid] || [];

        if (resultSummary === '__removed__') {
          clearSdkTaskCleanupTimer(agentId);
          clearSdkTaskStaleTimer(agentId);
          clearDbTaskAgentCleanupTimer(agentId);
          const filtered = existing.filter((a) => a.id !== agentId);
          const nextAgentStreaming = { ...s.agentStreaming };
          delete nextAgentStreaming[agentId];
          const nextActiveTab = { ...s.activeAgentTab };
          if (nextActiveTab[chatJid] === agentId) nextActiveTab[chatJid] = null;
          const nextSdkTasks = { ...s.sdkTasks };
          delete nextSdkTasks[agentId];
          const nextSdkTaskAliases = removeSdkTaskAliases(s.sdkTaskAliases, agentId);
          const nextAgentMessages = { ...s.agentMessages };
          delete nextAgentMessages[agentId];
          const nextAgentWaiting = { ...s.agentWaiting };
          delete nextAgentWaiting[agentId];
          const nextAgentHasMore = { ...s.agentHasMore };
          delete nextAgentHasMore[agentId];
          return {
            agents: { ...s.agents, [chatJid]: filtered },
            agentStreaming: nextAgentStreaming,
            activeAgentTab: nextActiveTab,
            sdkTasks: nextSdkTasks,
            sdkTaskAliases: nextSdkTaskAliases,
            agentMessages: nextAgentMessages,
            agentWaiting: nextAgentWaiting,
            agentHasMore: nextAgentHasMore,
          };
        }

        const idx = existing.findIndex((a) => a.id === agentId);
        const resolvedKind = kind || (idx >= 0 ? existing[idx].kind : 'task');
        const agentInfo: AgentInfo = {
          id: agentId,
          name,
          prompt,
          status,
          kind: resolvedKind,
          created_at: idx >= 0 ? existing[idx].created_at : new Date().toISOString(),
          completed_at: (status === 'completed' || status === 'error') ? new Date().toISOString() : undefined,
          result_summary: resultSummary,
        };
        const updated = idx >= 0
          ? existing.map((a, i) => (i === idx ? agentInfo : a))
          : [...existing, agentInfo];

        const nextAgentStreaming = { ...s.agentStreaming };
        if (status !== 'running') {
          delete nextAgentStreaming[agentId];
        }
        const nextSdkTasks = { ...s.sdkTasks };
        let nextSdkTaskAliases = { ...s.sdkTaskAliases };
        if (resolvedKind === 'task') {
          if (status !== 'running') {
            markSdkTaskCompleted(agentId);
            clearSdkTaskCleanupTimer(agentId);
            clearSdkTaskStaleTimer(agentId);
            delete nextSdkTasks[agentId];
            nextSdkTaskAliases = removeSdkTaskAliases(nextSdkTaskAliases, agentId);
            scheduleDbTaskAgentCleanup(set, agentId, chatJid);
          } else {
            clearDbTaskAgentCleanupTimer(agentId);
            if (nextSdkTasks[agentId]) {
              nextSdkTasks[agentId] = {
                ...nextSdkTasks[agentId],
                chatJid,
                description: prompt,
                status: 'running',
              };
            }
          }
        }
        if (resolvedKind === 'spawn' && (status === 'completed' || status === 'error')) {
          scheduleDbTaskAgentCleanup(set, agentId, chatJid);
        }

        const nextAgentWaiting =
          (resolvedKind === 'conversation' || resolvedKind === 'spawn') && status === 'running'
            ? { ...s.agentWaiting, [agentId]: true }
            : s.agentWaiting;

        return {
          agents: { ...s.agents, [chatJid]: updated },
          agentStreaming: nextAgentStreaming,
          agentWaiting: nextAgentWaiting,
          sdkTasks: nextSdkTasks,
          sdkTaskAliases: nextSdkTaskAliases,
        };
      });
    },

    loadAgents: async (jid) => {
      try {
        const data = await api.get<{ agents: AgentInfo[] }>(
          `/api/groups/${encodeURIComponent(jid)}/agents`,
        );
        set((s) => {
          const visibleAgents = data.agents.filter((a) => a.kind === 'conversation' || (a.kind === 'spawn' && a.status !== 'completed') || a.status === 'running');
          const runningTasks = data.agents.filter((a) => a.kind === 'task' && a.status === 'running');
          const runningTaskIds = new Set(runningTasks.map((a) => a.id));
          const runningTaskMap = new Map(runningTasks.map((a) => [a.id, a]));

          const nextSdkTasks: ChatState['sdkTasks'] = {};
          for (const [id, task] of Object.entries(s.sdkTasks)) {
            if (task.chatJid !== jid) {
              nextSdkTasks[id] = task;
              continue;
            }
            if (runningTaskIds.has(id)) {
              const agent = runningTaskMap.get(id)!;
              nextSdkTasks[id] = {
                ...task,
                chatJid: jid,
                description: agent.prompt || agent.name,
                status: 'running',
              };
            } else {
              clearSdkTaskCleanupTimer(id);
              clearSdkTaskStaleTimer(id);
            }
          }

          for (const agent of runningTasks) {
            if (!nextSdkTasks[agent.id]) {
              nextSdkTasks[agent.id] = {
                chatJid: jid,
                description: agent.prompt || agent.name,
                status: 'running',
              };
            }
          }

          const nextAgentStreaming = { ...s.agentStreaming };
          for (const [id, task] of Object.entries(s.sdkTasks)) {
            if (task.chatJid === jid && !runningTaskIds.has(id)) {
              delete nextAgentStreaming[id];
            }
          }

          const nextActiveTab = { ...s.activeAgentTab };
          if (nextActiveTab[jid] && !runningTaskIds.has(nextActiveTab[jid]!)) {
            const stillExists = visibleAgents.some((a) => a.id === nextActiveTab[jid]);
            if (!stillExists) nextActiveTab[jid] = null;
          }

          const nextSdkTaskAliases: Record<string, string> = {};
          for (const [alias, target] of Object.entries(s.sdkTaskAliases)) {
            const task = nextSdkTasks[target];
            if (!task) continue;
            if (task.chatJid === jid && task.status !== 'running') continue;
            if (alias === target && task.status !== 'running') continue;
            nextSdkTaskAliases[alias] = target;
          }

          return {
            agents: { ...s.agents, [jid]: visibleAgents },
            sdkTasks: nextSdkTasks,
            sdkTaskAliases: nextSdkTaskAliases,
            agentStreaming: nextAgentStreaming,
            activeAgentTab: nextActiveTab,
          };
        });
      } catch {
        // Silent fail
      }
    },

    deleteAgentAction: async (jid, agentId) => {
      try {
        await api.delete(`/api/groups/${encodeURIComponent(jid)}/agents/${agentId}`);
        clearSdkTaskCleanupTimer(agentId);
        clearSdkTaskStaleTimer(agentId);
        set((s) => {
          const updated = (s.agents[jid] || []).filter((a) => a.id !== agentId);
          const nextAgentStreaming = { ...s.agentStreaming };
          delete nextAgentStreaming[agentId];
          const nextActiveTab = { ...s.activeAgentTab };
          if (nextActiveTab[jid] === agentId) nextActiveTab[jid] = null;
          const nextSdkTasks = { ...s.sdkTasks };
          delete nextSdkTasks[agentId];
          const nextSdkTaskAliases = removeSdkTaskAliases(s.sdkTaskAliases, agentId);
          return {
            agents: { ...s.agents, [jid]: updated },
            agentStreaming: nextAgentStreaming,
            activeAgentTab: nextActiveTab,
            sdkTasks: nextSdkTasks,
            sdkTaskAliases: nextSdkTaskAliases,
          };
        });
        return true;
      } catch {
        return false;
      }
    },

    setActiveAgentTab: (jid, agentId) => {
      set((s) => ({
        activeAgentTab: { ...s.activeAgentTab, [jid]: agentId },
      }));
      persistActiveAgentTabSelection(jid, agentId);
    },

    createConversation: async (jid, name, description) => {
      try {
        const data = await api.post<{ agent: AgentInfo }>(
          `/api/groups/${encodeURIComponent(jid)}/agents`,
          { name, description },
        );
        set((s) => {
          const existing = s.agents[jid] || [];
          if (existing.some((a) => a.id === data.agent.id)) return s;
          return { agents: { ...s.agents, [jid]: [...existing, data.agent] } };
        });
        return data.agent;
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },

    renameConversation: async (jid, agentId, name) => {
      try {
        await api.patch(`/api/groups/${encodeURIComponent(jid)}/agents/${agentId}`, { name });
        set((s) => {
          const agents = (s.agents[jid] || []).map((a) =>
            a.id === agentId ? { ...a, name } : a,
          );
          return { agents: { ...s.agents, [jid]: agents } };
        });
        return true;
      } catch {
        return false;
      }
    },

    loadAgentMessages: async (jid, agentId, loadMore = false) => {
      const existing = get().agentMessages[agentId] || [];
      const before = loadMore && existing.length > 0 ? existing[0].timestamp : undefined;

      try {
        const params = new URLSearchParams(
          before
            ? { before: String(before), limit: '50', agentId }
            : { limit: '50', agentId },
        );
        const data = await api.get<{ messages: import('../types').Message[]; hasMore: boolean }>(
          `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
        );
        const sorted = [...data.messages].reverse();
        set((s) => {
          const merged = mergeMessagesChronologically(
            s.agentMessages[agentId] || [],
            sorted,
          );
          return {
            agentMessages: { ...s.agentMessages, [agentId]: merged },
            agentHasMore: { ...s.agentHasMore, [agentId]: data.hasMore },
          };
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    sendAgentMessage: (jid, agentId, content, attachments) => {
      set((s) => {
        const next = { ...s.agentStreaming };
        delete next[agentId];
        return { agentStreaming: next };
      });
      const normalizedAttachments = attachments && attachments.length > 0
        ? attachments.map((att) => ({ type: 'image' as const, ...att }))
        : undefined;
      const sent = wsManager.send({ type: 'send_message', chatJid: jid, content, agentId, attachments: normalizedAttachments });
      if (!sent) {
        showToast('发送失败', 'WebSocket 未连接，请稍后重试');
        return;
      }
      set((s) => ({
        agentWaiting: { ...s.agentWaiting, [agentId]: true },
      }));
    },

    refreshAgentMessages: async (jid, agentId) => {
      const existing = get().agentMessages[agentId] || [];
      const lastTs = existing.length > 0 ? existing[existing.length - 1].timestamp : undefined;

      try {
        const params = new URLSearchParams({ limit: '50', agentId });
        if (lastTs) params.set('after', lastTs);

        const data = await api.get<{ messages: import('../types').Message[] }>(
          `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
        );

        if (data.messages.length > 0) {
          set((s) => {
            const merged = mergeMessagesChronologically(
              s.agentMessages[agentId] || [],
              data.messages,
            );
            const agentReplied = data.messages.some(
              (m) =>
                m.is_from_me &&
                m.sender !== '__system__' &&
                m.source_kind !== 'sdk_send_message',
            );
            const nextAgentStreaming = agentReplied
              ? (() => {
                  const n = { ...s.agentStreaming };
                  delete n[agentId];
                  return n;
                })()
              : s.agentStreaming;

            return {
              agentMessages: { ...s.agentMessages, [agentId]: merged },
              agentWaiting: agentReplied
                ? { ...s.agentWaiting, [agentId]: false }
                : s.agentWaiting,
              agentStreaming: nextAgentStreaming,
            };
          });
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

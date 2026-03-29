import {
  DB_TASK_AGENT_AUTO_CLEAN_MS,
  SDK_TASK_AUTO_CLOSE_MS,
  SDK_TASK_STALE_TIMEOUT_MS,
} from './constants.ts';
import { removeSdkTaskAliases } from './helpers.ts';
import type { ChatStoreGet, ChatStoreSet } from './types.ts';

const sdkTaskCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sdkTaskStaleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const completedSdkTaskIds = new Set<string>();
const dbTaskAgentCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function hasCompletedSdkTask(taskId: string): boolean {
  return completedSdkTaskIds.has(taskId);
}

export function markSdkTaskCompleted(taskId: string): void {
  completedSdkTaskIds.add(taskId);
}

export function clearDbTaskAgentCleanupTimer(agentId: string): void {
  const timer = dbTaskAgentCleanupTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    dbTaskAgentCleanupTimers.delete(agentId);
  }
}

export function scheduleDbTaskAgentCleanup(
  set: ChatStoreSet,
  agentId: string,
  chatJid: string,
): void {
  clearDbTaskAgentCleanupTimer(agentId);
  const timer = setTimeout(() => {
    dbTaskAgentCleanupTimers.delete(agentId);
    set((s) => {
      const existing = s.agents[chatJid] || [];
      const filtered = existing.filter((a) => a.id !== agentId);
      if (filtered.length === existing.length) return {};
      const nextActiveTab = { ...s.activeAgentTab };
      if (nextActiveTab[chatJid] === agentId) nextActiveTab[chatJid] = null;
      return {
        agents: { ...s.agents, [chatJid]: filtered },
        activeAgentTab: nextActiveTab,
      };
    });
  }, DB_TASK_AGENT_AUTO_CLEAN_MS);
  dbTaskAgentCleanupTimers.set(agentId, timer);
}

export function clearSdkTaskCleanupTimer(taskId: string): void {
  const timer = sdkTaskCleanupTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    sdkTaskCleanupTimers.delete(taskId);
  }
}

export function clearSdkTaskStaleTimer(taskId: string): void {
  const timer = sdkTaskStaleTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    sdkTaskStaleTimers.delete(taskId);
  }
}

/**
 * Reset the stale timer for a non-teammate SDK task.
 * If no events are received within SDK_TASK_STALE_TIMEOUT_MS, auto-finalize it.
 */
export function resetSdkTaskStaleTimer(
  set: ChatStoreSet,
  get: ChatStoreGet,
  taskId: string,
  chatJid: string,
): void {
  clearSdkTaskStaleTimer(taskId);
  const timer = setTimeout(() => {
    sdkTaskStaleTimers.delete(taskId);
    const state = get();
    const task = state.sdkTasks[taskId];
    if (task && task.status === 'running' && !task.isTeammate) {
      set((s) => {
        const existingTask = s.sdkTasks[taskId];
        if (!existingTask || existingTask.status !== 'running') return {};
        return {
          sdkTasks: {
            ...s.sdkTasks,
            [taskId]: { ...existingTask, status: 'completed' as const },
          },
        };
      });
      scheduleSdkTaskCleanup(set, taskId, chatJid, SDK_TASK_AUTO_CLOSE_MS);
    }
  }, SDK_TASK_STALE_TIMEOUT_MS);
  sdkTaskStaleTimers.set(taskId, timer);
}

function doSdkTaskCleanup(
  set: ChatStoreSet,
  taskId: string,
  _chatJid: string,
): void {
  sdkTaskCleanupTimers.delete(taskId);
  clearSdkTaskStaleTimer(taskId);
  completedSdkTaskIds.delete(taskId);
  set((s) => {
    const nextSdkTasks = { ...s.sdkTasks };
    delete nextSdkTasks[taskId];
    const nextAliases = removeSdkTaskAliases(s.sdkTaskAliases, taskId);
    return {
      sdkTasks: nextSdkTasks,
      sdkTaskAliases: nextAliases,
    };
  });
}

export function scheduleSdkTaskCleanup(
  set: ChatStoreSet,
  taskId: string,
  chatJid: string,
  delayMs = SDK_TASK_AUTO_CLOSE_MS,
): void {
  clearSdkTaskCleanupTimer(taskId);
  const timer = setTimeout(() => {
    doSdkTaskCleanup(set, taskId, chatJid);
  }, delayMs);
  sdkTaskCleanupTimers.set(taskId, timer);
}

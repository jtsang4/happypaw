import {
  ACTIVE_AGENT_TABS_STORAGE_KEY,
  DEFAULT_STREAMING_STATE,
  STREAMING_STORAGE_KEY,
} from './constants';
import type { StreamingState } from './types';

const streamingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced save of streaming state to sessionStorage (trailing-edge, 500ms per jid). */
export function saveStreamingToSession(chatJid: string, state: StreamingState | undefined): void {
  const existing = streamingSaveTimers.get(chatJid);
  if (existing) clearTimeout(existing);
  streamingSaveTimers.set(chatJid, setTimeout(() => {
    streamingSaveTimers.delete(chatJid);
    try {
      const stored = JSON.parse(sessionStorage.getItem(STREAMING_STORAGE_KEY) || '{}');
      if (state && (state.partialText || state.activeTools.length > 0 || state.recentEvents.length > 0)) {
        stored[chatJid] = {
          partialText: state.partialText.slice(-4000),
          thinkingText: '',
          isThinking: false,
          activeTools: state.activeTools,
          recentEvents: state.recentEvents.slice(-10),
          todos: state.todos,
          systemStatus: state.systemStatus,
          turnId: state.turnId,
          ts: Date.now(),
        };
      } else {
        delete stored[chatJid];
      }
      sessionStorage.setItem(STREAMING_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // quota exceeded or SSR
    }
  }, 500));
}

/** Remove streaming state from sessionStorage. */
export function clearStreamingFromSession(chatJid: string): void {
  const timer = streamingSaveTimers.get(chatJid);
  if (timer) {
    clearTimeout(timer);
    streamingSaveTimers.delete(chatJid);
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(STREAMING_STORAGE_KEY) || '{}');
    delete stored[chatJid];
    sessionStorage.setItem(STREAMING_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // SSR
  }
}

/** Restore streaming state from sessionStorage (stale entries > 5min are discarded). */
export function restoreStreamingFromSession(chatJid: string): StreamingState | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STREAMING_STORAGE_KEY) || '{}');
    const entry = stored[chatJid];
    if (!entry) return null;
    if (Date.now() - (entry.ts || 0) > 5 * 60 * 1000) {
      delete stored[chatJid];
      sessionStorage.setItem(STREAMING_STORAGE_KEY, JSON.stringify(stored));
      return null;
    }
    return {
      ...DEFAULT_STREAMING_STATE,
      partialText: entry.partialText || '',
      activeTools: entry.activeTools || [],
      recentEvents: entry.recentEvents || [],
      todos: entry.todos,
      systemStatus: entry.systemStatus || null,
      turnId: entry.turnId,
    };
  } catch {
    return null;
  }
}

export function loadPersistedActiveAgentTabs(): Record<string, string | null> {
  try {
    return JSON.parse(sessionStorage.getItem(ACTIVE_AGENT_TABS_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function persistActiveAgentTabSelection(jid: string, agentId: string | null): void {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ACTIVE_AGENT_TABS_STORAGE_KEY) || '{}');
    if (agentId) {
      stored[jid] = agentId;
    } else {
      delete stored[jid];
    }
    sessionStorage.setItem(ACTIVE_AGENT_TABS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // ignore
  }
}

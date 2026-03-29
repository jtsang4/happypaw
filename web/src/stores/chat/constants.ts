import type { StreamingState } from './types.ts';

export const MAX_THINKING_CACHE_SIZE = 500;
export const MAX_STREAMING_TEXT = 8000;
export const MAX_EVENT_LOG = 30;
export const SDK_TASK_AUTO_CLOSE_MS = 3000;
export const SDK_TASK_TOOL_END_FALLBACK_CLOSE_MS = 1200;
export const SDK_TASK_STALE_TIMEOUT_MS = 5 * 60 * 1000;
export const DB_TASK_AGENT_AUTO_CLEAN_MS = 5000;
export const STREAMING_STORAGE_KEY = 'hc_streaming';
export const ACTIVE_AGENT_TABS_STORAGE_KEY = 'hc_activeAgentTabs';

export const DEFAULT_STREAMING_STATE: StreamingState = {
  turnId: undefined,
  sessionId: undefined,
  partialText: '',
  thinkingText: '',
  isThinking: false,
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
};

import { create } from 'zustand';
import { createAgentActions } from './actions/agent-actions.ts';
import { createGroupActions } from './actions/group-actions.ts';
import { createImActions } from './actions/im-actions.ts';
import { createMessageActions } from './actions/message-actions.ts';
import { createStreamActions } from './actions/stream-actions.ts';
import { loadPersistedActiveAgentTabs } from './persistence.ts';
import type { ChatState } from './types.ts';

export const useChatStore = create<ChatState>((set, get) => ({
  groups: {},
  currentGroup: null,
  messages: {},
  waiting: {},
  hasMore: {},
  loading: false,
  error: null,
  streaming: {},
  thinkingCache: {},
  pendingThinking: {},
  clearing: {},
  agents: {},
  agentStreaming: {},
  activeAgentTab: loadPersistedActiveAgentTabs(),
  sdkTasks: {},
  sdkTaskAliases: {},
  agentMessages: {},
  agentWaiting: {},
  agentHasMore: {},
  drafts: {},
  ...createGroupActions(set, get),
  ...createMessageActions(set, get),
  ...createAgentActions(set, get),
  ...createImActions(set, get),
  ...createStreamActions(set, get),
}));

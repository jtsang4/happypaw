import { create } from 'zustand';
import { createAgentActions } from './actions/agent-actions';
import { createGroupActions } from './actions/group-actions';
import { createImActions } from './actions/im-actions';
import { createMessageActions } from './actions/message-actions';
import { createStreamActions } from './actions/stream-actions';
import { loadPersistedActiveAgentTabs } from './persistence';
import type { ChatState } from './types';

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

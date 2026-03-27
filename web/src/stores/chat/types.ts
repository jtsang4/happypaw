import type { StoreApi } from 'zustand';
import type { GroupInfo, AgentInfo, AvailableImGroup } from '../../types';
import type { StreamEventType, StreamEvent } from '../../stream-event.types';

export type { GroupInfo, AgentInfo, AvailableImGroup, StreamEventType, StreamEvent };

export interface Message {
  id: string;
  chat_jid: string;
  source_jid?: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  attachments?: string;
  token_usage?: string;
  turn_id?: string | null;
  session_id?: string | null;
  sdk_message_uuid?: string | null;
  source_kind?: 'sdk_final' | 'sdk_send_message' | 'interrupt_partial' | 'legacy' | null;
  finalization_reason?: 'completed' | 'interrupted' | 'error' | null;
}

export interface StreamingTimelineEvent {
  id: string;
  timestamp: number;
  text: string;
  kind: 'tool' | 'skill' | 'hook' | 'status';
}

/** Shape of the snapshot payload pushed from the backend on WS reconnect (stream_snapshot). */
export interface StreamSnapshotData {
  partialText: string;
  activeTools: Array<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    toolInputSummary?: string;
    toolInput?: Record<string, unknown>;
    parentToolUseId?: string | null;
  }>;
  recentEvents: Array<{
    id: string;
    timestamp: number;
    text: string;
    kind: 'tool' | 'skill' | 'hook' | 'status';
  }>;
  todos?: Array<{ id: string; content: string; status: string }>;
  systemStatus: string | null;
  turnId?: string;
}

export interface StreamingState {
  turnId?: string;
  sessionId?: string;
  partialText: string;
  thinkingText: string;
  isThinking: boolean;
  activeTools: Array<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    elapsedSeconds?: number;
    parentToolUseId?: string | null;
    isNested?: boolean;
    skillName?: string;
    toolInputSummary?: string;
    toolInput?: Record<string, unknown>;
  }>;
  activeHook: { hookName: string; hookEvent: string } | null;
  systemStatus: string | null;
  recentEvents: StreamingTimelineEvent[];
  todos?: Array<{ id: string; content: string; status: string }>;
  interrupted?: boolean;
}

export interface CreateFlowOptions {
  execution_mode?: 'container' | 'host';
  runtime?: 'claude_sdk' | 'codex_app_server';
  custom_cwd?: string;
  init_source_path?: string;
  init_git_url?: string;
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export interface SdkTaskInfo {
  chatJid: string;
  description: string;
  status: 'running' | 'completed' | 'error';
  summary?: string;
  isTeammate?: boolean;
  startedAt?: number;
}

export interface ChatState {
  groups: Record<string, GroupInfo>;
  currentGroup: string | null;
  messages: Record<string, Message[]>;
  waiting: Record<string, boolean>;
  hasMore: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  streaming: Record<string, StreamingState>;
  thinkingCache: Record<string, string>;
  pendingThinking: Record<string, string>;
  clearing: Record<string, boolean>;
  agents: Record<string, AgentInfo[]>;
  agentStreaming: Record<string, StreamingState>;
  activeAgentTab: Record<string, string | null>;
  sdkTasks: Record<string, SdkTaskInfo>;
  sdkTaskAliases: Record<string, string>;
  agentMessages: Record<string, Message[]>;
  agentWaiting: Record<string, boolean>;
  agentHasMore: Record<string, boolean>;
  loadGroups: () => Promise<void>;
  selectGroup: (jid: string) => void;
  loadMessages: (jid: string, loadMore?: boolean) => Promise<void>;
  refreshMessages: (jid: string) => Promise<void>;
  sendMessage: (jid: string, content: string, attachments?: ImageAttachment[]) => Promise<void>;
  stopGroup: (jid: string) => Promise<boolean>;
  interruptQuery: (jid: string) => Promise<boolean>;
  resetSession: (jid: string, agentId?: string) => Promise<boolean>;
  clearHistory: (jid: string) => Promise<boolean>;
  deleteMessage: (jid: string, messageId: string) => Promise<boolean>;
  createFlow: (name: string, options?: CreateFlowOptions) => Promise<{ jid: string; folder: string } | null>;
  renameFlow: (jid: string, name: string) => Promise<void>;
  updateFlowRuntime: (jid: string, runtime: 'claude_sdk' | 'codex_app_server' | null) => Promise<void>;
  togglePin: (jid: string) => Promise<void>;
  deleteFlow: (jid: string) => Promise<void>;
  handleStreamEvent: (chatJid: string, event: StreamEvent, agentId?: string) => void;
  handleWsNewMessage: (chatJid: string, wsMsg: any, agentId?: string, source?: string) => void;
  handleAgentStatus: (
    chatJid: string,
    agentId: string,
    status: AgentInfo['status'],
    name: string,
    prompt: string,
    resultSummary?: string,
    kind?: AgentInfo['kind'],
  ) => void;
  clearStreaming: (chatJid: string, options?: { preserveThinking?: boolean }) => void;
  restoreActiveState: () => Promise<void>;
  handleStreamSnapshot: (chatJid: string, snapshot: StreamSnapshotData, agentId?: string) => void;
  loadAgents: (jid: string) => Promise<void>;
  deleteAgentAction: (jid: string, agentId: string) => Promise<boolean>;
  setActiveAgentTab: (jid: string, agentId: string | null) => void;
  createConversation: (jid: string, name: string, description?: string) => Promise<AgentInfo | null>;
  renameConversation: (jid: string, agentId: string, name: string) => Promise<boolean>;
  loadAgentMessages: (jid: string, agentId: string, loadMore?: boolean) => Promise<void>;
  sendAgentMessage: (jid: string, agentId: string, content: string, attachments?: ImageAttachment[]) => void;
  refreshAgentMessages: (jid: string, agentId: string) => Promise<void>;
  handleRunnerState: (chatJid: string, state: string) => void;
  loadAvailableImGroups: (jid: string) => Promise<AvailableImGroup[]>;
  bindImGroup: (jid: string, agentId: string, imJid: string, force?: boolean) => Promise<boolean>;
  unbindImGroup: (jid: string, agentId: string, imJid: string) => Promise<boolean>;
  bindMainImGroup: (jid: string, imJid: string, force?: boolean, activationMode?: string) => Promise<boolean>;
  unbindMainImGroup: (jid: string, imJid: string) => Promise<boolean>;
  drafts: Record<string, string>;
  saveDraft: (jid: string, text: string) => void;
  clearDraft: (jid: string) => void;
}

export interface PendingDelta {
  texts: string[];
  thinkings: string[];
  raf: number;
}

export type ChatStoreSet = StoreApi<ChatState>['setState'];
export type ChatStoreGet = StoreApi<ChatState>['getState'];

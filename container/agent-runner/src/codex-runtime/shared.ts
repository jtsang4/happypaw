import type { CodexAppServerClient } from '../codex-client.js';
import type { v2 } from '../generated/codex-app-server-protocol/index.js';
import type { ContainerInput, ContainerOutput } from '../types.js';

export type Base64ImageInput = {
  data: string;
  mimeType?: string;
};

export type FollowUpMessage = {
  text: string;
  images?: Base64ImageInput[];
  sessionId?: string;
  chatJid?: string;
  replyRouteJid?: string;
};

export type StreamResult = {
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  lastAssistantUuid?: string;
  newSessionId?: string;
  unrecoverableTranscriptError?: boolean;
  contextOverflow?: boolean;
  sessionResumeFailed?: boolean;
  followUpInput?: FollowUpMessage;
  clientDiedUnexpectedly?: boolean;
};

export type CodexTodo = {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type RequestUserInputPrompt = {
  requestId: string;
  itemId: string;
  questionId: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  isOther: boolean;
  isSecret: boolean;
};

export type RequestUserInputQuestion = v2.ToolRequestUserInputQuestion;
export type RequestUserInputResponse = v2.ToolRequestUserInputResponse;
export type ThreadStartResult = v2.ThreadStartResponse;
export type ThreadResumeResult = v2.ThreadResumeResponse;
export type TurnStartResult = v2.TurnStartResponse;
export type McpServerStatusListResult = v2.ListMcpServerStatusResponse;
export type CodexUserInput = v2.UserInput;

export type ReasoningItemState = {
  surfacedSummaryIndexes: Set<number>;
  summaryTextByIndex: Map<number, string>;
  pendingSummaryIndexes: Set<number>;
};

export type CodexMcpServerStatus = {
  name: string;
  authStatus?: string;
  tools: string[];
};

export interface RuntimeDeps {
  WORKSPACE_GLOBAL: string;
  WORKSPACE_GROUP: string;
  WORKSPACE_MEMORY: string;
  SECURITY_RULES: string;
  log: (message: string) => void;
  writeOutput: (output: ContainerOutput) => void;
  shouldInterrupt: () => boolean;
  shouldClose: () => boolean;
  shouldDrain: () => boolean;
  drainIpcInput: () => {
    messages: FollowUpMessage[];
  };
  normalizeHomeFlags: (input: ContainerInput) => {
    isHome: boolean;
    isAdminHome: boolean;
  };
  buildChannelGuidelines: (channel: string) => string;
  truncateWithHeadTail: (content: string, maxChars: number) => string;
  generateTurnId: () => string;
  getPersistentClient?: () => CodexAppServerClient | undefined;
  setPersistentClient?: (client: CodexAppServerClient | undefined) => void;
}

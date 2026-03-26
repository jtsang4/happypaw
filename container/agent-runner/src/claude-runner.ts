import type { StreamEvent } from './types.js';

export type HookCallback = (
  input: unknown,
  toolUseId?: string,
  context?: unknown,
) => Promise<Record<string, unknown>>;

export interface PreCompactHookInput {
  transcript_path?: string;
  session_id: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface LegacyRunnerResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  contextOverflow?: boolean;
  unrecoverableTranscriptError?: boolean;
  interruptedDuringQuery: boolean;
  sessionResumeFailed?: boolean;
  followUpInput?: {
    text: string;
    images?: Array<{ data: string; mimeType?: string }>;
  };
}

export function runLegacyClaudeQuery(): Promise<LegacyRunnerResult> {
  return Promise.reject(
    new Error('Claude runtime has been removed; use Codex runtime instead.'),
  );
}

export function isContextOverflowError(_msg: string): boolean {
  return false;
}

export function isUnrecoverableTranscriptError(_msg: string): boolean {
  return false;
}

export function buildMemoryRecallPrompt(): string {
  return '';
}

export function buildChannelGuidelines(_channel: string): string {
  return '';
}

export function truncateWithHeadTail(content: string): string {
  return content;
}

export function normalizeLegacyStreamEvent(event: StreamEvent): StreamEvent {
  return event;
}

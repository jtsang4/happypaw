import {
  DEFAULT_STREAMING_STATE,
  MAX_EVENT_LOG,
  MAX_STREAMING_TEXT,
} from './constants.ts';
import { saveStreamingToSession } from './persistence.ts';
import type {
  ChatStoreSet,
  PendingDelta,
  StreamEvent,
  StreamingState,
  StreamingTimelineEvent,
} from './types.ts';

const pendingDeltas = new Map<string, PendingDelta>();

function getPendingDeltaKey(chatJid: string, agentId?: string): string {
  return agentId ? `agent:${agentId}` : `main:${chatJid}`;
}

/**
 * Resolve the previous StreamingState for a new event, resetting if turnId changed.
 */
export function resolveStreamingPrev(
  current: StreamingState | undefined,
  event: StreamEvent,
): StreamingState {
  if (current?.turnId && event.turnId && current.turnId !== event.turnId) {
    return { ...DEFAULT_STREAMING_STATE, turnId: event.turnId, sessionId: event.sessionId };
  }
  return current || { ...DEFAULT_STREAMING_STATE };
}

function flushPendingDelta(
  key: string,
  chatJid: string,
  agentId: string | undefined,
  set: ChatStoreSet,
): void {
  const entry = pendingDeltas.get(key);
  if (!entry) return;
  pendingDeltas.delete(key);

  const mergedText = entry.texts.join('');
  const mergedThinking = entry.thinkings.join('');

  if (agentId) {
    set((s) => {
      if (!s.agentStreaming[agentId] && s.agentWaiting[agentId] === false) return s;
      const prev = s.agentStreaming[agentId] || { ...DEFAULT_STREAMING_STATE };
      const next = { ...prev };
      if (mergedText) {
        const combined = prev.partialText + mergedText;
        next.partialText = combined.length > MAX_STREAMING_TEXT ? combined.slice(-MAX_STREAMING_TEXT) : combined;
        next.isThinking = false;
      }
      if (mergedThinking) {
        const combined = prev.thinkingText + mergedThinking;
        next.thinkingText = combined.length > MAX_STREAMING_TEXT ? combined.slice(-MAX_STREAMING_TEXT) : combined;
        next.isThinking = true;
      }
      return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
    });
    return;
  }

  set((s) => {
    if (!s.streaming[chatJid] && s.waiting[chatJid] === false) return s;
    if (s.streaming[chatJid]?.interrupted) return s;
    const prev = s.streaming[chatJid] || { ...DEFAULT_STREAMING_STATE };
    const next = { ...prev };
    if (mergedText) {
      const combined = prev.partialText + mergedText;
      next.partialText = combined.length > MAX_STREAMING_TEXT ? combined.slice(-MAX_STREAMING_TEXT) : combined;
      next.isThinking = false;
    }
    if (mergedThinking) {
      const combined = prev.thinkingText + mergedThinking;
      next.thinkingText = combined.length > MAX_STREAMING_TEXT ? combined.slice(-MAX_STREAMING_TEXT) : combined;
      next.isThinking = true;
    }
    saveStreamingToSession(chatJid, next);
    return {
      waiting: { ...s.waiting, [chatJid]: true },
      streaming: { ...s.streaming, [chatJid]: next },
    };
  });
}

export function queuePendingStreamDelta(
  chatJid: string,
  event: StreamEvent,
  agentId: string | undefined,
  set: ChatStoreSet,
): boolean {
  if (event.eventType !== 'text_delta' && event.eventType !== 'thinking_delta') {
    return false;
  }

  const key = getPendingDeltaKey(chatJid, agentId);
  let entry = pendingDeltas.get(key);
  if (entry) {
    if (event.eventType === 'text_delta') entry.texts.push(event.text || '');
    else entry.thinkings.push(event.text || '');
    return true;
  }

  entry = { texts: [], thinkings: [], raf: 0 };
  if (event.eventType === 'text_delta') entry.texts.push(event.text || '');
  else entry.thinkings.push(event.text || '');
  entry.raf = requestAnimationFrame(() => {
    flushPendingDelta(key, chatJid, agentId, set);
  });
  pendingDeltas.set(key, entry);
  return true;
}

export function flushPendingMainStreamDelta(chatJid: string, set: ChatStoreSet): void {
  const key = getPendingDeltaKey(chatJid);
  const entry = pendingDeltas.get(key);
  if (!entry) return;
  cancelAnimationFrame(entry.raf);
  flushPendingDelta(key, chatJid, undefined, set);
}

export function clearPendingMainStreamDelta(chatJid: string): void {
  const key = getPendingDeltaKey(chatJid);
  const entry = pendingDeltas.get(key);
  if (!entry) return;
  cancelAnimationFrame(entry.raf);
  pendingDeltas.delete(key);
}

function pushEvent(
  events: StreamingTimelineEvent[],
  kind: StreamingTimelineEvent['kind'],
  text: string,
): StreamingTimelineEvent[] {
  const item: StreamingTimelineEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    kind,
    text,
  };
  return [...events, item].slice(-MAX_EVENT_LOG);
}

/**
 * Apply a single StreamEvent to a StreamingState object.
 * Shared by main conversation and SDK subagent streaming.
 */
export function applyStreamEvent(
  event: StreamEvent,
  prev: StreamingState,
  next: StreamingState,
  maxText: number,
): void {
  if (event.turnId) next.turnId = event.turnId;
  if (event.sessionId) next.sessionId = event.sessionId;
  switch (event.eventType) {
    case 'text_delta': {
      const combined = prev.partialText + (event.text || '');
      next.partialText = combined.length > maxText ? combined.slice(-maxText) : combined;
      next.isThinking = false;
      break;
    }
    case 'thinking_delta': {
      const combined = prev.thinkingText + (event.text || '');
      next.thinkingText = combined.length > maxText ? combined.slice(-maxText) : combined;
      next.isThinking = true;
      break;
    }
    case 'tool_use_start': {
      next.isThinking = false;
      const toolUseId = event.toolUseId || '';
      const existing = prev.activeTools.find((t) => t.toolUseId === toolUseId && toolUseId);
      const tool = {
        toolName: event.toolName || 'unknown',
        toolUseId,
        startTime: Date.now(),
        parentToolUseId: event.parentToolUseId,
        isNested: event.isNested,
        skillName: event.skillName,
        toolInputSummary: event.toolInputSummary,
        ...(event.toolInput ? { toolInput: event.toolInput } : {}),
      };
      next.activeTools = existing
        ? prev.activeTools.map((t) => (t.toolUseId === toolUseId ? { ...t, ...tool } : t))
        : [...prev.activeTools, tool];

      const isSkill = tool.toolName === 'Skill';
      const label = isSkill
        ? `技能 ${tool.skillName || 'unknown'}`
        : `工具 ${tool.toolName}`;
      const detail = tool.toolInputSummary ? ` (${tool.toolInputSummary})` : '';
      next.recentEvents = pushEvent(prev.recentEvents, isSkill ? 'skill' : 'tool', `${label}${detail}`);
      break;
    }
    case 'tool_use_end':
      if (event.toolUseId) {
        const ended = prev.activeTools.find((t) => t.toolUseId === event.toolUseId);
        next.activeTools = prev.activeTools.filter((t) => t.toolUseId !== event.toolUseId);
        if (ended) {
          const rawSec = (Date.now() - ended.startTime) / 1000;
          const elapsedSec = rawSec % 1 === 0 ? rawSec.toFixed(0) : rawSec.toFixed(1);
          const isSkill = ended.toolName === 'Skill';
          const label = isSkill
            ? `技能 ${ended.skillName || 'unknown'}`
            : `工具 ${ended.toolName}`;
          next.recentEvents = pushEvent(prev.recentEvents, isSkill ? 'skill' : 'tool', `✓ ${label} (${elapsedSec}s)`);
        }
      } else {
        next.activeTools = [];
      }
      break;
    case 'tool_progress': {
      const existing = prev.activeTools.find((t) => t.toolUseId === event.toolUseId);
      if (existing) {
        const skillNameResolved = event.skillName && !existing.skillName;
        next.activeTools = prev.activeTools.map((t) =>
          t.toolUseId === event.toolUseId
            ? {
                ...t,
                elapsedSeconds: event.elapsedSeconds,
                ...(event.skillName ? { skillName: event.skillName } : {}),
                ...(event.toolInput ? { toolInput: event.toolInput } : {}),
              }
            : t,
        );
        if (skillNameResolved) {
          const oldLabel = '技能 unknown';
          const newLabel = `技能 ${event.skillName}`;
          next.recentEvents = prev.recentEvents.map((e) =>
            e.kind === 'skill' && e.text.includes(oldLabel)
              ? { ...e, text: e.text.replace(oldLabel, newLabel) }
              : e,
          );
        }
      } else {
        next.activeTools = [...prev.activeTools, {
          toolName: event.toolName || 'unknown',
          toolUseId: event.toolUseId || '',
          startTime: Date.now(),
          parentToolUseId: event.parentToolUseId,
          isNested: event.isNested,
          elapsedSeconds: event.elapsedSeconds,
        }];
      }
      break;
    }
    case 'hook_started':
      next.activeHook = { hookName: event.hookName || '', hookEvent: event.hookEvent || '' };
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'hook',
        `Hook 开始: ${event.hookName || 'unknown'} (${event.hookEvent || 'unknown'})`,
      );
      break;
    case 'hook_progress':
      next.activeHook = { hookName: event.hookName || '', hookEvent: event.hookEvent || '' };
      break;
    case 'hook_response':
      next.activeHook = null;
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'hook',
        `Hook 结束: ${event.hookName || 'unknown'} (${event.hookOutcome || 'success'})`,
      );
      break;
    case 'todo_update':
      if (event.todos) {
        next.todos = event.todos;
      }
      break;
    case 'status': {
      next.systemStatus = event.statusText || null;
      if (event.statusText) {
        next.recentEvents = pushEvent(prev.recentEvents, 'status', `状态: ${event.statusText}`);
      }
      break;
    }
    case 'usage':
    case 'init':
      break;
  }
}

export function buildRestoredStreamingState(snapshot: {
  partialText: string;
  activeTools: Array<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    toolInputSummary?: string;
    toolInput?: Record<string, unknown>;
    parentToolUseId?: string | null;
  }>;
  recentEvents: StreamingTimelineEvent[];
  todos?: Array<{ id: string; content: string; status: string }>;
  systemStatus: string | null;
  turnId?: string;
}): StreamingState {
  return {
    ...DEFAULT_STREAMING_STATE,
    partialText: snapshot.partialText || '',
    activeTools: (snapshot.activeTools || []).map((t) => ({
      toolName: t.toolName,
      toolUseId: t.toolUseId,
      startTime: t.startTime,
      toolInputSummary: t.toolInputSummary,
      toolInput: t.toolInput,
      parentToolUseId: t.parentToolUseId,
    })),
    recentEvents: (snapshot.recentEvents || []) as StreamingTimelineEvent[],
    todos: snapshot.todos,
    systemStatus: snapshot.systemStatus || null,
    turnId: snapshot.turnId,
  };
}

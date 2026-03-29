import { MAX_THINKING_CACHE_SIZE } from './constants.ts';
import type { ChatState, Message } from './types.ts';

export function mergeMessagesChronologically(
  existing: Message[],
  incoming: Message[],
): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) {
    const old = byId.get(m.id);
    if (
      !old ||
      old.content !== m.content ||
      old.timestamp !== m.timestamp ||
      old.token_usage !== m.token_usage ||
      old.turn_id !== m.turn_id ||
      old.session_id !== m.session_id ||
      old.sdk_message_uuid !== m.sdk_message_uuid ||
      old.source_kind !== m.source_kind ||
      old.finalization_reason !== m.finalization_reason
    ) {
      byId.set(m.id, m);
    }
  }
  const result = Array.from(byId.values()).sort((a, b) => {
    if (a.timestamp === b.timestamp) return a.id.localeCompare(b.id);
    return a.timestamp.localeCompare(b.timestamp);
  });
  if (result.length < existing.length) {
    const missingIds = existing.filter((m) => !byId.has(m.id)).map((m) => m.id);
    console.warn(
      '[mergeMessages] Message count decreased!',
      { before: existing.length, after: result.length, incoming: incoming.length, missingIds },
    );
  }
  return result;
}

/** Evict oldest entries when cache exceeds capacity (relies on insertion order) */
export function capThinkingCache(cache: Record<string, string>): Record<string, string> {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_THINKING_CACHE_SIZE) return cache;
  const keep = keys.slice(keys.length - MAX_THINKING_CACHE_SIZE);
  const next: Record<string, string> = {};
  for (const k of keep) next[k] = cache[k];
  return next;
}

export function retainThinkingCacheForMessages(
  messagesByGroup: Record<string, Message[]>,
  cache: Record<string, string>,
): Record<string, string> {
  const aliveMessageIds = new Set<string>();
  for (const messages of Object.values(messagesByGroup)) {
    for (const m of messages) aliveMessageIds.add(m.id);
  }

  const next: Record<string, string> = {};
  for (const [messageId, content] of Object.entries(cache)) {
    if (aliveMessageIds.has(messageId)) next[messageId] = content;
  }
  return capThinkingCache(next);
}

export function removeSdkTaskAliases(
  aliases: Record<string, string>,
  taskId: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias === taskId || target === taskId) continue;
    next[alias] = target;
  }
  return next;
}

export function resolveSdkTaskId(
  state: Pick<ChatState, 'sdkTasks' | 'sdkTaskAliases'>,
  rawId: string,
): string {
  if (state.sdkTasks[rawId]) return rawId;
  return state.sdkTaskAliases[rawId] || rawId;
}

export function pickSdkTaskAliasTarget(
  state: Pick<ChatState, 'sdkTasks' | 'sdkTaskAliases' | 'agents'>,
  chatJid: string,
): string | null {
  const runningIds = Object.entries(state.sdkTasks)
    .filter(([, task]) => task.chatJid === chatJid && task.status === 'running')
    .map(([id]) => id);
  if (runningIds.length === 0) return null;

  const usedTargets = new Set(Object.values(state.sdkTaskAliases));
  const unbound = runningIds.filter((id) => !usedTargets.has(id));
  const pool = (unbound.length > 0 ? unbound : runningIds).slice();
  const createdAtMap = new Map((state.agents[chatJid] || []).map((a) => [a.id, a.created_at]));
  pool.sort((a, b) => (createdAtMap.get(a) || '').localeCompare(createdAtMap.get(b) || ''));
  return pool[0] || null;
}

export function isTerminalSystemMessage(message: Pick<Message, 'sender' | 'content'>): boolean {
  if (message.sender === '__billing__') return true;
  return message.sender === '__system__' && (
    message.content.startsWith('agent_error:') ||
    message.content.startsWith('agent_max_retries:') ||
    message.content.startsWith('context_overflow:')
  );
}

export function isInterruptSystemMessage(message: Pick<Message, 'sender' | 'content'>): boolean {
  return message.sender === '__system__' && message.content === 'query_interrupted';
}

import { WebSocket } from 'ws';

import {
  wsClients,
  getCachedSessionWithUser,
  invalidateSessionCache,
} from './context.js';
import {
  getAgent,
  getGroupMembers,
  getJidsByFolder,
  getRegisteredGroup,
} from '../../db.js';
import { deleteUserSession } from '../../db.js';
import { isSessionExpired } from '../../features/auth/auth.js';
import { isHostExecutionGroup } from './context.js';
import type {
  AgentKind,
  AgentStatus,
  BillingAccessResult,
  NewMessage,
  StreamEvent,
  WsMessageOut,
} from '../../shared/types.js';

interface StreamingSnapshotEntry {
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
  updatedAt: number;
}

interface StreamingSnapshotPayload {
  partialText: string;
  activeTools: StreamingSnapshotEntry['activeTools'];
  recentEvents: StreamingSnapshotEntry['recentEvents'];
  todos?: StreamingSnapshotEntry['todos'];
  systemStatus: string | null;
  turnId?: string;
}

const allowedUserIdsCache = new Map<
  string,
  { ids: Set<string> | null; expiry: number }
>();
const ALLOWED_CACHE_TTL = 10_000;

const streamingSnapshots = new Map<string, StreamingSnapshotEntry>();
const streamingFullTexts = new Map<string, string>();
const MAX_SNAPSHOT_TEXT = 4000;
const MAX_SNAPSHOT_EVENTS = 20;
const SNAPSHOT_STALE_MS = 30 * 60 * 1000;

function safeBroadcast(
  msg: WsMessageOut,
  adminOnly = false,
  allowedUserIds?: Set<string> | null,
): void {
  const data = JSON.stringify(msg);
  for (const [client, clientInfo] of wsClients) {
    if (client.readyState !== WebSocket.OPEN) {
      wsClients.delete(client);
      continue;
    }

    if (!clientInfo.sessionId) {
      wsClients.delete(client);
      try {
        client.close(1008, 'Unauthorized');
      } catch {
        /* ignore */
      }
      continue;
    }

    const session = getCachedSessionWithUser(clientInfo.sessionId);
    const expired = !!session && isSessionExpired(session.expires_at);
    const invalid = !session || expired || session.status !== 'active';
    if (invalid) {
      if (expired) {
        deleteUserSession(clientInfo.sessionId);
      }
      invalidateSessionCache(clientInfo.sessionId);
      wsClients.delete(client);
      try {
        client.close(1008, 'Unauthorized');
      } catch {
        /* ignore */
      }
      continue;
    }

    if (adminOnly && session.role !== 'admin') {
      continue;
    }

    if (allowedUserIds !== undefined) {
      if (allowedUserIds === null || !allowedUserIds.has(session.user_id)) {
        continue;
      }
    }

    try {
      client.send(data);
    } catch {
      wsClients.delete(client);
    }
  }
}

function getGroupAllowedUserIds(chatJid: string): Set<string> | null {
  const now = Date.now();
  const cached = allowedUserIdsCache.get(chatJid);
  if (cached && cached.expiry > now) return cached.ids;

  const result = computeGroupAllowedUserIds(chatJid);
  allowedUserIdsCache.set(chatJid, {
    ids: result,
    expiry: now + ALLOWED_CACHE_TTL,
  });
  return result;
}

function computeGroupAllowedUserIds(chatJid: string): Set<string> | null {
  const group = getRegisteredGroup(chatJid);
  if (!group) return null;

  const ownerId = group.created_by ?? null;
  if (!ownerId) {
    if (group.is_home) return null;
    if (group.folder === 'main') return null;
    return null;
  }

  const allowed = new Set<string>([ownerId]);
  if (!group.is_home) {
    const members = getGroupMembers(group.folder);
    for (const member of members) {
      allowed.add(member.user_id);
    }
  }

  return allowed;
}

function isHostGroupJid(chatJid: string): boolean {
  const group = getRegisteredGroup(chatJid);
  return !!group && isHostExecutionGroup(group);
}

function normalizeHomeJid(chatJid: string): string {
  if (chatJid.startsWith('web:')) return chatJid;
  const group = getRegisteredGroup(chatJid);
  if (!group) return chatJid;

  for (const jid of getJidsByFolder(group.folder)) {
    if (jid.startsWith('web:')) {
      return jid;
    }
  }

  return chatJid;
}

function pushRecentEvent(
  snap: StreamingSnapshotEntry,
  event: StreamingSnapshotEntry['recentEvents'][number],
): void {
  snap.recentEvents.push(event);
  if (snap.recentEvents.length > MAX_SNAPSHOT_EVENTS) {
    snap.recentEvents = snap.recentEvents.slice(-MAX_SNAPSHOT_EVENTS);
  }
}

function updateStreamingSnapshot(
  normalizedJid: string,
  event: StreamEvent,
): void {
  let snap = streamingSnapshots.get(normalizedJid);

  if (snap?.turnId && event.turnId && snap.turnId !== event.turnId) {
    snap = undefined;
    streamingFullTexts.delete(normalizedJid);
  }

  if (!snap) {
    snap = {
      partialText: '',
      activeTools: [],
      recentEvents: [],
      systemStatus: null,
      turnId: event.turnId,
      updatedAt: Date.now(),
    };
  }

  snap.updatedAt = Date.now();
  if (event.turnId) snap.turnId = event.turnId;

  switch (event.eventType) {
    case 'text_delta':
      if (event.text) {
        snap.partialText += event.text;
        if (snap.partialText.length > MAX_SNAPSHOT_TEXT) {
          snap.partialText = snap.partialText.slice(-MAX_SNAPSHOT_TEXT);
        }
        streamingFullTexts.set(
          normalizedJid,
          (streamingFullTexts.get(normalizedJid) || '') + event.text,
        );
      }
      break;
    case 'tool_use_start':
      if (event.toolUseId && event.toolName) {
        snap.activeTools.push({
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          startTime: Date.now(),
          toolInputSummary: event.toolInputSummary,
          toolInput: event.toolInput,
          parentToolUseId: event.parentToolUseId,
        });
        pushRecentEvent(snap, {
          id: event.toolUseId,
          timestamp: Date.now(),
          text: event.skillName || event.toolName,
          kind: event.skillName ? 'skill' : 'tool',
        });
      }
      break;
    case 'tool_use_end':
      if (event.toolUseId) {
        snap.activeTools = snap.activeTools.filter(
          (tool) => tool.toolUseId !== event.toolUseId,
        );
      }
      break;
    case 'tool_progress':
      if (event.toolUseId) {
        const tool = snap.activeTools.find(
          (activeTool) => activeTool.toolUseId === event.toolUseId,
        );
        if (tool) {
          if (event.toolInputSummary) {
            tool.toolInputSummary = event.toolInputSummary;
          }
          if (event.toolInput) tool.toolInput = event.toolInput;
        }
      }
      break;
    case 'status':
      snap.systemStatus = event.statusText || null;
      if (event.statusText) {
        pushRecentEvent(snap, {
          id: `status-${Date.now()}`,
          timestamp: Date.now(),
          text: event.statusText,
          kind: 'status',
        });
      }
      break;
    case 'hook_started':
      if (event.hookName) {
        pushRecentEvent(snap, {
          id: `hook-${Date.now()}`,
          timestamp: Date.now(),
          text: `${event.hookName} (${event.hookEvent || ''})`,
          kind: 'hook',
        });
      }
      break;
    case 'todo_update':
      if (event.todos) {
        snap.todos = event.todos.map((todo) => ({
          id: todo.id,
          content: todo.content,
          status: todo.status,
        }));
      }
      break;
  }

  streamingSnapshots.set(normalizedJid, snap);
}

function clearRunnerSnapshots(normalizedJid: string): void {
  streamingSnapshots.delete(normalizedJid);
  streamingFullTexts.delete(normalizedJid);

  const agentPrefix = `${normalizedJid}#agent:`;
  const snapshotKeys = [...streamingSnapshots.keys()].filter((key) =>
    key.startsWith(agentPrefix),
  );
  const fullTextKeys = [...streamingFullTexts.keys()].filter((key) =>
    key.startsWith(agentPrefix),
  );

  for (const key of snapshotKeys) streamingSnapshots.delete(key);
  for (const key of fullTextKeys) streamingFullTexts.delete(key);
}

function toStreamingSnapshotPayload(
  snap: StreamingSnapshotEntry,
): StreamingSnapshotPayload {
  return {
    partialText: snap.partialText,
    activeTools: snap.activeTools,
    recentEvents: snap.recentEvents,
    todos: snap.todos,
    systemStatus: snap.systemStatus,
    turnId: snap.turnId,
  };
}

export function getStreamingSnapshotsForUser(
  userId: string,
): Array<{ chatJid: string; snapshot: StreamingSnapshotPayload }> {
  const snapshots: Array<{
    chatJid: string;
    snapshot: StreamingSnapshotPayload;
  }> = [];

  for (const [jid, snap] of streamingSnapshots) {
    if (Date.now() - snap.updatedAt > SNAPSHOT_STALE_MS) {
      streamingSnapshots.delete(jid);
      continue;
    }
    if (
      !snap.partialText &&
      snap.activeTools.length === 0 &&
      snap.recentEvents.length === 0
    ) {
      continue;
    }

    const baseJid = jid.includes('#agent:') ? jid.split('#agent:')[0] : jid;
    const allowed = getGroupAllowedUserIds(baseJid);
    if (allowed === null || !allowed.has(userId)) continue;

    snapshots.push({
      chatJid: jid,
      snapshot: toStreamingSnapshotPayload(snap),
    });
  }

  return snapshots;
}

export function getAccessibleBroadcastJid(
  chatJid: string,
  userId: string,
): string | null {
  const allowed = getGroupAllowedUserIds(chatJid);
  if (allowed === null || !allowed.has(userId)) {
    return null;
  }
  return normalizeHomeJid(chatJid);
}

export function invalidateAllowedUserCache(chatJid: string): void {
  allowedUserIdsCache.delete(chatJid);
  const group = getRegisteredGroup(chatJid);
  if (!group) return;

  for (const jid of getJidsByFolder(group.folder)) {
    allowedUserIdsCache.delete(jid);
  }
}

export function broadcastToWebClients(chatJid: string, text: string): void {
  const timestamp = new Date().toISOString();
  safeBroadcast(
    {
      type: 'agent_reply',
      chatJid: normalizeHomeJid(chatJid),
      text,
      timestamp,
    },
    isHostGroupJid(chatJid),
    getGroupAllowedUserIds(chatJid),
  );
}

export function broadcastNewMessage(
  chatJid: string,
  msg: NewMessage & { is_from_me?: boolean },
  agentId?: string,
  source?: string,
): void {
  let baseChatJid = chatJid;
  let effectiveAgentId = agentId;
  if (chatJid.includes('#agent:')) {
    const [baseJid, extractedAgentId] = chatJid.split('#agent:');
    baseChatJid = baseJid;
    if (!effectiveAgentId) effectiveAgentId = extractedAgentId;
  }

  const wsMsg: WsMessageOut = {
    type: 'new_message',
    chatJid: normalizeHomeJid(baseChatJid),
    message: { ...msg, is_from_me: msg.is_from_me ?? false },
    ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
    ...(source ? { source } : {}),
  };
  safeBroadcast(
    wsMsg,
    isHostGroupJid(baseChatJid),
    getGroupAllowedUserIds(baseChatJid),
  );
}

export function broadcastTyping(chatJid: string, isTyping: boolean): void {
  safeBroadcast(
    { type: 'typing', chatJid: normalizeHomeJid(chatJid), isTyping },
    isHostGroupJid(chatJid),
    getGroupAllowedUserIds(chatJid),
  );
}

export function clearStreamingSnapshot(chatJid: string): void {
  clearRunnerSnapshots(normalizeHomeJid(chatJid));
}

export function getActiveStreamingTexts(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [jid, fullText] of streamingFullTexts) {
    const text = fullText.trim();
    if (text) result.set(jid, text);
  }
  return result;
}

export function broadcastStreamEvent(
  chatJid: string,
  event: StreamEvent,
  agentId?: string,
): void {
  const normalizedJid = normalizeHomeJid(chatJid);
  const msg: WsMessageOut = agentId
    ? { type: 'stream_event', chatJid: normalizedJid, event, agentId }
    : { type: 'stream_event', chatJid: normalizedJid, event };
  safeBroadcast(msg, isHostGroupJid(chatJid), getGroupAllowedUserIds(chatJid));

  const snapshotJid = agentId
    ? `${normalizedJid}#agent:${agentId}`
    : normalizedJid;
  updateStreamingSnapshot(snapshotJid, event);
}

export function broadcastBillingUpdate(
  userId: string,
  usage: BillingAccessResult,
): void {
  safeBroadcast(
    { type: 'billing_update', userId, usage },
    false,
    new Set([userId]),
  );
}

export function broadcastAgentStatus(
  chatJid: string,
  agentId: string,
  status: AgentStatus,
  name: string,
  prompt: string,
  resultSummary?: string,
  kind?: AgentKind,
): void {
  const msg: WsMessageOut = {
    type: 'agent_status',
    chatJid: normalizeHomeJid(chatJid),
    agentId,
    status,
    kind: kind || getAgent(agentId)?.kind,
    name,
    prompt,
    resultSummary,
  };
  safeBroadcast(msg, isHostGroupJid(chatJid), getGroupAllowedUserIds(chatJid));
}

export function broadcastRunnerState(
  chatJid: string,
  state: 'idle' | 'running',
): void {
  const normalizedJid = normalizeHomeJid(chatJid);
  safeBroadcast(
    { type: 'runner_state', chatJid: normalizedJid, state },
    isHostGroupJid(chatJid),
    getGroupAllowedUserIds(chatJid),
  );

  if (state === 'idle') {
    clearRunnerSnapshots(normalizedJid);
  }
}

export function broadcastDockerBuildLog(line: string): void {
  safeBroadcast({ type: 'docker_build_log', line }, true);
}

export function broadcastDockerBuildComplete(
  success: boolean,
  error?: string,
): void {
  safeBroadcast({ type: 'docker_build_complete', success, error }, true);
}

export function broadcastStatusUpdate(status: {
  activeContainers: number;
  activeHostProcesses: number;
  activeTotal: number;
  queueLength: number;
}): void {
  safeBroadcast(
    {
      type: 'status_update',
      activeContainers: status.activeContainers,
      activeHostProcesses: status.activeHostProcesses,
      activeTotal: status.activeTotal,
      queueLength: status.queueLength,
    },
    true,
  );
}

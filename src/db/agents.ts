import type { AgentKind, AgentStatus, SubAgent } from '../shared/types.js';

import { db } from './shared.js';

export function createAgent(agent: SubAgent): void {
  db.prepare(
    `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, kind, created_by, created_at, completed_at, result_summary, spawned_from_jid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id,
    agent.group_folder,
    agent.chat_jid,
    agent.name,
    agent.prompt,
    agent.status,
    agent.kind || 'task',
    agent.created_by ?? null,
    agent.created_at,
    agent.completed_at ?? null,
    agent.result_summary ?? null,
    agent.spawned_from_jid ?? null,
  );
}

export function getAgent(id: string): SubAgent | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return mapAgentRow(row);
}

export function listAgentsByFolder(folder: string): SubAgent[] {
  const rows = db
    .prepare(
      'SELECT * FROM agents WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(folder) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function listAgentsByJid(chatJid: string): SubAgent[] {
  const rows = db
    .prepare('SELECT * FROM agents WHERE chat_jid = ? ORDER BY created_at DESC')
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function updateAgentStatus(
  id: string,
  status: AgentStatus,
  resultSummary?: string,
): void {
  const completedAt =
    status !== 'running' && status !== 'idle' ? new Date().toISOString() : null;
  db.prepare(
    'UPDATE agents SET status = ?, completed_at = ?, result_summary = ? WHERE id = ?',
  ).run(status, completedAt, resultSummary ?? null, id);
}

export function updateAgentLastImJid(
  id: string,
  lastImJid: string | null,
): void {
  db.prepare('UPDATE agents SET last_im_jid = ? WHERE id = ?').run(
    lastImJid,
    id,
  );
}

export function updateAgentInfo(
  id: string,
  name: string,
  prompt: string,
): void {
  db.prepare('UPDATE agents SET name = ?, prompt = ? WHERE id = ?').run(
    name,
    prompt,
    id,
  );
}

export function deleteCompletedAgents(beforeTimestamp: string): number {
  const result = db
    .prepare(
      "DELETE FROM agents WHERE kind IN ('task', 'spawn') AND status IN ('completed', 'error') AND completed_at IS NOT NULL AND completed_at < ?",
    )
    .run(beforeTimestamp);
  return result.changes;
}

export function getRunningTaskAgentsByChat(chatJid: string): SubAgent[] {
  const rows = db
    .prepare(
      "SELECT * FROM agents WHERE chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function markRunningTaskAgentsAsError(chatJid: string): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ? WHERE chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .run(now, chatJid);
  return result.changes;
}

export function markAllRunningTaskAgentsAsError(
  summary = '进程重启，任务中断',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'task' AND status = 'running'",
    )
    .run(now, summary);
  return result.changes;
}

/**
 * Mark stale spawn agents (idle/running) as error at startup.
 * After a process restart, spawn agents that were idle or running can never
 * resume — their in-memory task callbacks are lost. Mark them as error so
 * they don't render as "正在思考..." in the frontend.
 */
export function markStaleSpawnAgentsAsError(
  summary = '进程重启，并行任务中断',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'spawn' AND status IN ('idle', 'running')",
    )
    .run(now, summary);
  return result.changes;
}

export function listActiveConversationAgents(): SubAgent[] {
  return (
    db
      .prepare(
        "SELECT * FROM agents WHERE kind IN ('conversation', 'spawn') AND status IN ('running', 'idle')",
      )
      .all() as Record<string, unknown>[]
  ).map(mapAgentRow);
}

export function deleteAgent(id: string): void {
  // Delete associated session
  db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function mapAgentRow(row: Record<string, unknown>): SubAgent {
  return {
    id: String(row.id),
    group_folder: String(row.group_folder),
    chat_jid: String(row.chat_jid),
    name: String(row.name),
    prompt: String(row.prompt),
    status: (row.status as AgentStatus) || 'running',
    kind: (row.kind as AgentKind) || 'task',
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at),
    completed_at:
      typeof row.completed_at === 'string' ? row.completed_at : null,
    result_summary:
      typeof row.result_summary === 'string' ? row.result_summary : null,
    last_im_jid: typeof row.last_im_jid === 'string' ? row.last_im_jid : null,
    spawned_from_jid:
      typeof row.spawned_from_jid === 'string' ? row.spawned_from_jid : null,
  };
}

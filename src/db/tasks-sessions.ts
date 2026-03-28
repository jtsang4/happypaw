import type {
  MessageCursor,
  NewMessage,
  RuntimeSessionRecord,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';

import { db, getNewMessagesStmt, stmts } from './shared.js';

export function getNewMessages(
  jids: string[],
  cursor: MessageCursor,
): { messages: NewMessage[]; newCursor: MessageCursor } {
  if (jids.length === 0) return { messages: [], newCursor: cursor };

  const rows = getNewMessagesStmt(jids.length).all(
    cursor.timestamp,
    cursor.timestamp,
    cursor.id,
    ...jids,
  ) as NewMessage[];
  const last = rows[rows.length - 1];
  return {
    messages: rows,
    newCursor: last ? { timestamp: last.timestamp, id: last.id } : cursor,
  };
}

export function getMessagesSince(
  chatJid: string,
  cursor: MessageCursor,
): NewMessage[] {
  return stmts().getMessagesSince.all(
    chatJid,
    cursor.timestamp,
    cursor.timestamp,
    cursor.id,
  ) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, execution_type, script_command, next_run, status, created_at, created_by, notify_channels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.execution_type || 'agent',
    task.script_command ?? null,
    task.next_run,
    task.status,
    task.created_at,
    task.created_by ?? null,
    task.notify_channels != null ? JSON.stringify(task.notify_channels) : null,
  );
}

/** Parse notify_channels from JSON string stored in DB */
function mapTaskRow(row: unknown): ScheduledTask {
  const r = row as any;
  if (typeof r.notify_channels === 'string') {
    try {
      r.notify_channels = JSON.parse(r.notify_channels);
    } catch {
      r.notify_channels = null;
    }
  } else if (r.notify_channels === undefined) {
    r.notify_channels = null;
  }
  return r as ScheduledTask;
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
  return row ? mapTaskRow(row) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder)
    .map(mapTaskRow);
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all()
    .map(mapTaskRow);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'execution_type'
      | 'script_command'
      | 'next_run'
      | 'status'
      | 'notify_channels'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.execution_type !== undefined) {
    fields.push('execution_type = ?');
    values.push(updates.execution_type);
  }
  if (updates.script_command !== undefined) {
    fields.push('script_command = ?');
    values.push(updates.script_command);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.notify_channels !== undefined) {
    fields.push('notify_channels = ?');
    values.push(
      updates.notify_channels != null
        ? JSON.stringify(updates.notify_channels)
        : null,
    );
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function deleteTasksForGroup(groupFolder: string): void {
  const tx = db.transaction((folder: string) => {
    db.prepare(
      `
      DELETE FROM task_run_logs
      WHERE task_id IN (
        SELECT id FROM scheduled_tasks WHERE group_folder = ?
      )
      `,
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
  });
  tx(groupFolder);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now)
    .map(mapTaskRow);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function cleanupOldTaskRunLogs(retentionDays = 30): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(`DELETE FROM task_run_logs WHERE run_at < ?`)
    .run(cutoff);
  return result.changes;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function deleteRouterState(key: string): void {
  db.prepare('DELETE FROM router_state WHERE key = ?').run(key);
}

export function getRouterStateByPrefix(
  prefix: string,
): Array<{ key: string; value: string }> {
  return db
    .prepare('SELECT key, value FROM router_state WHERE key LIKE ?')
    .all(`${prefix}%`) as Array<{ key: string; value: string }>;
}

// --- Session accessors ---

export function getSession(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  return getRuntimeSession(groupFolder, agentId)?.sessionId;
}

export function getRuntimeSession(
  groupFolder: string,
  agentId?: string | null,
): RuntimeSessionRecord | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as { session_id: string } | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
  };
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
  _runtime?: unknown,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, runtime) VALUES (?, ?, ?, NULL)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET session_id = excluded.session_id, runtime = NULL`,
  ).run(groupFolder, sessionId, effectiveAgentId);
}

export function deleteSession(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    'DELETE FROM sessions WHERE group_folder = ? AND agent_id = ?',
  ).run(groupFolder, effectiveAgentId);
}

export function deleteAllSessionsForFolder(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, RuntimeSessionRecord> {
  const rows = db
    .prepare(
      "SELECT group_folder, session_id FROM sessions WHERE agent_id = ''",
    )
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, RuntimeSessionRecord> = {};
  for (const row of rows) {
    result[row.group_folder] = {
      sessionId: row.session_id,
    };
  }
  return result;
}

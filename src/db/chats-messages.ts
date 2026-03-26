import crypto from 'crypto';

import { logger } from '../logger.js';
import type { MessageCursor, NewMessage, TaskRunLog } from '../types.js';

import { db, stmts, type StoredMessageMeta } from './shared.js';

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Ensure a chat row exists in the chats table (avoids FK violation on messages insert).
 */
export function ensureChatExists(chatJid: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
  ).run(chatJid, chatJid, new Date().toISOString());
}

/**
 * Store a message with full content (channel-agnostic).
 * Only call this for registered groups where message history is needed.
 */
export function storeMessageDirect(
  msgId: string,
  chatJid: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  opts?: {
    attachments?: string;
    tokenUsage?: string;
    sourceJid?: string;
    meta?: StoredMessageMeta;
  },
): string {
  const { attachments, tokenUsage, sourceJid, meta } = opts ?? {};
  const existingFinalRow =
    meta?.sourceKind === 'sdk_final' && meta.turnId
      ? (stmts().storeMessageSelect.get(chatJid, meta.turnId) as
          | { id: string }
          | undefined)
      : undefined;
  const effectiveMsgId = existingFinalRow?.id || msgId;
  stmts().storeMessageInsert.run(
    effectiveMsgId,
    chatJid,
    sourceJid ?? chatJid,
    sender,
    senderName,
    content,
    timestamp,
    isFromMe ? 1 : 0,
    attachments ?? null,
    tokenUsage ?? null,
    meta?.turnId ?? null,
    meta?.sessionId ?? null,
    meta?.sdkMessageUuid ?? null,
    meta?.sourceKind ?? null,
    meta?.finalizationReason ?? null,
  );
  return effectiveMsgId;
}

/**
 * Update the token_usage field on a specific agent message, or fall back to
 * the most recent agent message without token_usage for the given chat.
 * When msgId is provided, uses precise `WHERE id = ? AND chat_jid = ?` match
 * to avoid race conditions in concurrent scenarios.
 */
export function updateLatestMessageTokenUsage(
  chatJid: string,
  tokenUsage: string,
  msgId?: string,
  costUsd?: number,
): void {
  if (msgId) {
    stmts().updateTokenUsageById.run(
      tokenUsage,
      costUsd ?? null,
      msgId,
      chatJid,
    );
  } else {
    stmts().updateTokenUsageLatest.run(tokenUsage, costUsd ?? null, chatJid);
  }
}

/**
 * Get token usage statistics aggregated by date.
 */
export function getTokenUsageStats(
  days: number,
  chatJids?: string[],
): Array<{
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  message_count: number;
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND m.chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const baseQuery = `
    SELECT
      date(m.timestamp) as date,
      json_extract(m.token_usage, '$.modelUsage') as model_usage_json,
      json_extract(m.token_usage, '$.inputTokens') as input_tokens,
      json_extract(m.token_usage, '$.outputTokens') as output_tokens,
      json_extract(m.token_usage, '$.cacheReadInputTokens') as cache_read_tokens,
      json_extract(m.token_usage, '$.cacheCreationInputTokens') as cache_creation_tokens,
      json_extract(m.token_usage, '$.costUSD') as cost_usd
    FROM messages m
    WHERE m.token_usage IS NOT NULL
      AND m.timestamp >= ?
      ${jidFilter}
    ORDER BY m.timestamp ASC
  `;

  const rows = db.prepare(baseQuery).all(...params) as Array<{
    date: string;
    model_usage_json: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
  }>;

  // Aggregate by date + model
  type AggregatedEntry = {
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    message_count: number;
  };
  const aggregated = new Map<string, AggregatedEntry>();

  function addToAggregated(
    date: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    costUsd: number,
  ): void {
    const key = `${date}|${model}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.input_tokens += inputTokens;
      existing.output_tokens += outputTokens;
      existing.cache_read_tokens += cacheReadTokens;
      existing.cache_creation_tokens += cacheCreationTokens;
      existing.cost_usd += costUsd;
      existing.message_count += 1;
    } else {
      aggregated.set(key, {
        date,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        cost_usd: costUsd,
        message_count: 1,
      });
    }
  }

  for (const row of rows) {
    if (row.model_usage_json) {
      try {
        const modelUsage = JSON.parse(row.model_usage_json) as Record<
          string,
          { inputTokens: number; outputTokens: number; costUSD: number }
        >;
        for (const [model, usage] of Object.entries(modelUsage)) {
          addToAggregated(
            row.date,
            model,
            usage.inputTokens || 0,
            usage.outputTokens || 0,
            0,
            0,
            usage.costUSD || 0,
          );
        }
      } catch (e) {
        logger.warn(
          { date: row.date, error: e },
          'Failed to parse model_usage_json',
        );
        // fallback: use aggregate fields
        addToAggregated(
          row.date,
          'unknown',
          row.input_tokens || 0,
          row.output_tokens || 0,
          row.cache_read_tokens || 0,
          row.cache_creation_tokens || 0,
          row.cost_usd || 0,
        );
      }
    } else {
      addToAggregated(
        row.date,
        'unknown',
        row.input_tokens || 0,
        row.output_tokens || 0,
        row.cache_read_tokens || 0,
        row.cache_creation_tokens || 0,
        row.cost_usd || 0,
      );
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Get token usage summary totals.
 */
export function getTokenUsageSummary(
  days: number,
  chatJids?: string[],
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(json_extract(token_usage, '$.inputTokens')), 0) as total_input,
      COALESCE(SUM(json_extract(token_usage, '$.outputTokens')), 0) as total_output,
      COALESCE(SUM(json_extract(token_usage, '$.cacheReadInputTokens')), 0) as total_cache_read,
      COALESCE(SUM(json_extract(token_usage, '$.cacheCreationInputTokens')), 0) as total_cache_creation,
      COALESCE(SUM(json_extract(token_usage, '$.costUSD')), 0) as total_cost,
      COUNT(*) as total_messages,
      COUNT(DISTINCT date(timestamp)) as total_active_days
    FROM messages
    WHERE token_usage IS NOT NULL AND timestamp >= ?
      ${jidFilter}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get a local timezone date string (YYYY-MM-DD) from a Date or ISO string.
 */
function toLocalDateString(date?: Date | string): string {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Insert a usage record and update daily summary.
 */
export function insertUsageRecord(record: {
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs?: number;
  numTurns?: number;
  source?: string;
}): void {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const localDate = toLocalDateString();

  db.transaction(() => {
    stmts().insertUsageInsert.run(
      id,
      record.userId,
      record.groupFolder,
      record.agentId ?? null,
      record.messageId ?? null,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
      record.durationMs ?? 0,
      record.numTurns ?? 0,
      record.source ?? 'agent',
      now,
    );
    stmts().insertUsageUpsert.run(
      record.userId,
      record.model,
      localDate,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
    );
  })();
}

/**
 * Get usage stats from daily summary table (fixes timezone + token KPI issues).
 */
export function getUsageDailyStats(
  days: number,
  userId?: string,
  modelFilter?: string,
): Array<{
  date: string;
  model: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  request_count: number;
}> {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  return db
    .prepare(
      `
    SELECT date, model, user_id,
      total_input_tokens as input_tokens,
      total_output_tokens as output_tokens,
      total_cache_read_tokens as cache_read_tokens,
      total_cache_creation_tokens as cache_creation_tokens,
      total_cost_usd as cost_usd,
      request_count
    FROM usage_daily_summary
    WHERE ${whereClause}
    ORDER BY date ASC
  `,
    )
    .all(...params) as Array<{
    date: string;
    model: string;
    user_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    request_count: number;
  }>;
}

/**
 * Get usage summary from daily summary table.
 */
export function getUsageDailySummary(
  days: number,
  userId?: string,
  modelFilter?: string,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(total_input_tokens), 0) as total_input,
      COALESCE(SUM(total_output_tokens), 0) as total_output,
      COALESCE(SUM(total_cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(total_cache_creation_tokens), 0) as total_cache_creation,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(request_count), 0) as total_messages,
      COUNT(DISTINCT date) as total_active_days
    FROM usage_daily_summary
    WHERE ${whereClause}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get list of all models that have usage data.
 */
export function getUsageModels(): string[] {
  const rows = db
    .prepare('SELECT DISTINCT model FROM usage_daily_summary ORDER BY model')
    .all() as Array<{ model: string }>;
  return rows.map((r) => r.model);
}

/**
 * Get list of users that have usage data.
 */
export function getUsageUsers(): Array<{ id: string; username: string }> {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT uds.user_id as id, COALESCE(u.username, uds.user_id) as username
    FROM usage_daily_summary uds
    LEFT JOIN users u ON u.id = uds.user_id
    ORDER BY u.username
  `,
    )
    .all() as Array<{ id: string; username: string }>;
  return rows;
}

export function getMessagesPage(
  chatJid: string,
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  const sql = before
    ? `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
      FROM messages
      WHERE chat_jid = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
    : `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;

  const params = before ? [chatJid, before, limit] : [chatJid, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * Get messages after a given timestamp (for polling new messages).
 * Returns in ASC order (oldest first).
 */
export function getMessagesAfter(
  chatJid: string,
  after: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, after, limit) as Array<NewMessage & { is_from_me: number }>;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * 多 JID 分页查询（用于主容器合并 web:main + feishu:xxx 消息）。
 */
export function getMessagesPageMulti(
  chatJids: string[],
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesPage(chatJids[0], before, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const sql = before
    ? `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    : `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT ?`;

  const params = before ? [...chatJids, before, limit] : [...chatJids, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * 多 JID 增量查询（用于主容器轮询合并消息）。
 */
export function getMessagesAfterMulti(
  chatJids: string[],
  after: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesAfter(chatJids[0], after, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(...chatJids, after, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * Get task run logs for a specific task, ordered by most recent first.
 */
export function getTaskRunLogs(taskId: string, limit = 20): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT id, task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `,
    )
    .all(taskId, limit) as TaskRunLog[];
}

// ===================== Daily Summary Queries =====================

/**
 * Get messages for a chat within a time range, ordered by timestamp ASC.
 */
export function getMessagesByTimeRange(
  chatJid: string,
  startTs: number,
  endTs: number,
  limit = 500,
): Array<NewMessage & { is_from_me: boolean }> {
  const startIso = new Date(startTs).toISOString();
  const endIso = new Date(endTs).toISOString();
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, startIso, endIso, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

export function deleteMessagesForChatJid(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
  db.prepare('DELETE FROM chats WHERE jid = ?').run(chatJid);
}

export function getMessage(
  chatJid: string,
  messageId: string,
): {
  id: string;
  chat_jid: string;
  sender: string | null;
  is_from_me: number;
} | null {
  const row = db
    .prepare(
      'SELECT id, chat_jid, sender, is_from_me FROM messages WHERE id = ? AND chat_jid = ?',
    )
    .get(messageId, chatJid) as
    | {
        id: string;
        chat_jid: string;
        sender: string | null;
        is_from_me: number;
      }
    | undefined;
  return row ?? null;
}

export function deleteMessage(chatJid: string, messageId: string): boolean {
  const result = db
    .prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?')
    .run(messageId, chatJid);
  return result.changes > 0;
}

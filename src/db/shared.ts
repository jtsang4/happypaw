import Database from '../shared/db/sqlite-compat.js';
import type {
  MessageFinalizationReason,
  MessageSourceKind,
} from '../shared/types.js';

type DatabaseInstance = InstanceType<typeof Database>;

let database: DatabaseInstance | null = null;

export function setDatabaseInstance(instance: DatabaseInstance): void {
  database = instance;
  resetPreparedStatementCaches();
}

export function getDb(): DatabaseInstance {
  if (!database) {
    throw new Error('Database not initialized');
  }
  return database;
}

export const db = new Proxy({} as DatabaseInstance, {
  get(_target, prop) {
    const currentDb = getDb();
    const value = Reflect.get(currentDb, prop, currentDb);
    return typeof value === 'function' ? value.bind(currentDb) : value;
  },
}) as DatabaseInstance;

// Prepared statement cache — lazy-initialized on first use after initDatabase()
let _stmts: {
  storeMessageSelect: any;
  storeMessageInsert: any;
  insertUsageInsert: any;
  insertUsageUpsert: any;
  getSessionWithUser: any;
  deleteSession: any;
  updateSessionLastActive: any;
  updateTokenUsageById: any;
  updateTokenUsageLatest: any;
  getMessagesSince: any;
  getExpiredSessionIds: any;
} | null = null;

const _newMsgStmtCache = new Map<number, any>();

export function resetPreparedStatementCaches(): void {
  _stmts = null;
  _newMsgStmtCache.clear();
}

export function closeDatabaseConnection(): void {
  resetPreparedStatementCaches();
  if (database) {
    database.close();
    database = null;
  }
}

export function stmts() {
  if (!_stmts) {
    const currentDb = getDb();
    _stmts = {
      storeMessageSelect: currentDb.prepare(
        `SELECT id FROM messages
         WHERE chat_jid = ? AND turn_id = ? AND source_kind = 'sdk_final'
         ORDER BY timestamp DESC LIMIT 1`,
      ),
      storeMessageInsert: currentDb.prepare(
        `INSERT OR REPLACE INTO messages (
          id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me,
          attachments, token_usage, turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageInsert: currentDb.prepare(
        `INSERT INTO usage_records (id, user_id, group_folder, agent_id, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageUpsert: currentDb.prepare(
        `INSERT INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(user_id, model, date) DO UPDATE SET
          total_input_tokens = total_input_tokens + excluded.total_input_tokens,
          total_output_tokens = total_output_tokens + excluded.total_output_tokens,
          total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
          total_cache_creation_tokens = total_cache_creation_tokens + excluded.total_cache_creation_tokens,
          total_cost_usd = total_cost_usd + excluded.total_cost_usd,
          request_count = request_count + 1,
          updated_at = datetime('now')`,
      ),
      getSessionWithUser: currentDb.prepare(
        `SELECT s.*, u.username, u.role, u.status, u.display_name, u.permissions, u.must_change_password
         FROM user_sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = ?`,
      ),
      deleteSession: currentDb.prepare(
        'DELETE FROM user_sessions WHERE id = ?',
      ),
      updateSessionLastActive: currentDb.prepare(
        'UPDATE user_sessions SET last_active_at = ? WHERE id = ?',
      ),
      updateTokenUsageById: currentDb.prepare(
        `UPDATE messages SET token_usage = ?, cost_usd = ? WHERE id = ? AND chat_jid = ?`,
      ),
      updateTokenUsageLatest: currentDb.prepare(
        `UPDATE messages SET token_usage = ?, cost_usd = ?
         WHERE rowid = (
           SELECT rowid FROM messages
           WHERE chat_jid = ? AND is_from_me = 1 AND token_usage IS NULL
             AND COALESCE(source_kind, 'legacy') != 'sdk_send_message'
           ORDER BY timestamp DESC LIMIT 1
         )`,
      ),
      getMessagesSince: currentDb.prepare(
        `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments
         FROM messages
         WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?)) AND is_from_me = 0
         ORDER BY timestamp ASC, id ASC`,
      ),
      getExpiredSessionIds: currentDb.prepare(
        'SELECT id FROM user_sessions WHERE expires_at < ?',
      ),
    };
  }
  return _stmts;
}

export function getNewMessagesStmt(jidCount: number): any {
  let s = _newMsgStmtCache.get(jidCount);
  if (!s) {
    const placeholders = Array(jidCount).fill('?').join(',');
    s = getDb().prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments
       FROM messages
       WHERE (timestamp > ? OR (timestamp = ? AND id > ?))
         AND chat_jid IN (${placeholders})
         AND is_from_me = 0
         AND COALESCE(source_kind, '') != 'user_command'
       ORDER BY timestamp ASC, id ASC`,
    );
    _newMsgStmtCache.set(jidCount, s);
  }
  return s;
}

interface StoredMessageMeta {
  turnId?: string | null;
  sessionId?: string | null;
  sdkMessageUuid?: string | null;
  sourceKind?: MessageSourceKind | null;
  finalizationReason?: MessageFinalizationReason | null;
}

export type { StoredMessageMeta };

export function hasColumn(tableName: string, columnName: string): boolean {
  const columns = getDb()
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

export function ensureColumn(
  tableName: string,
  columnName: string,
  sqlTypeWithDefault: string,
): void {
  if (hasColumn(tableName, columnName)) return;
  getDb().exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlTypeWithDefault}`,
  );
}

export function assertSchema(
  tableName: string,
  requiredColumns: string[],
  forbiddenColumns: string[] = [],
): void {
  const columns = getDb()
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((c) => c.name));

  const missing = requiredColumns.filter((c) => !names.has(c));
  const forbidden = forbiddenColumns.filter((c) => names.has(c));

  if (missing.length > 0 || forbidden.length > 0) {
    throw new Error(
      `Incompatible DB schema in table "${tableName}". Missing: [${missing.join(
        ', ',
      )}], forbidden: [${forbidden.join(', ')}]. ` +
        'Please remove data/db/messages.db (or legacy store/messages.db) and restart.',
    );
  }
}

/** Internal helper — reads router_state before initDatabase exports are available. */
export function getRouterStateInternal(key: string): string | undefined {
  try {
    const row = getDb()
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined; // Table may not exist yet on first run
  }
}

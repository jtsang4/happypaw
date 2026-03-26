import fs from 'fs';
import path from 'path';

import Database from '../sqlite-compat.js';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { UserRole } from '../types.js';

import {
  assertSchema,
  closeDatabaseConnection,
  db,
  ensureColumn,
  getRouterStateInternal,
  setDatabaseInstance,
} from './shared.js';

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  setDatabaseInstance(new Database(dbPath));

  // Enable WAL mode for better concurrency and performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      source_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT,
      token_usage TEXT,
      turn_id TEXT,
      session_id TEXT,
      sdk_message_uuid TEXT,
      source_kind TEXT,
      finalization_reason TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      execution_type TEXT DEFAULT 'agent',
      script_command TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      created_by TEXT,
      notify_channels TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
  `);

  // State tables (replacing JSON files)
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      runtime TEXT,
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      runtime TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    );
  `);

  // Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disable_reason TEXT,
      notes TEXT,
      avatar_emoji TEXT,
      avatar_color TEXT,
      ai_name TEXT,
      ai_avatar_emoji TEXT,
      ai_avatar_color TEXT,
      ai_avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      permission_template TEXT,
      permissions TEXT NOT NULL DEFAULT '[]',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      username TEXT NOT NULL,
      actor_username TEXT,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
    CREATE INDEX IF NOT EXISTS idx_invites_created_at ON invite_codes(created_at);
  `);

  // Group members table for shared workspaces
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_folder TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      added_at TEXT NOT NULL,
      added_by TEXT,
      PRIMARY KEY (group_folder, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
  `);

  // User pinned groups (per-user workspace pinning)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_pinned_groups (
      user_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, jid)
    );
  `);

  // Sub-agents table for multi-agent parallel execution
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_by TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT,
      last_im_jid TEXT,
      spawned_from_jid TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_group ON agents(group_folder);
    CREATE INDEX IF NOT EXISTS idx_agents_jid ON agents(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  `);

  // Billing tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tier INTEGER NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_token_quota INTEGER,
      monthly_cost_quota REAL,
      daily_cost_quota REAL,
      weekly_cost_quota REAL,
      daily_token_quota INTEGER,
      weekly_token_quota INTEGER,
      rate_multiplier REAL NOT NULL DEFAULT 1.0,
      trial_days INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      display_price TEXT,
      highlight INTEGER NOT NULL DEFAULT 0,
      max_groups INTEGER,
      max_concurrent_containers INTEGER,
      max_im_channels INTEGER,
      max_mcp_servers INTEGER,
      max_storage_mb INTEGER,
      allow_overage INTEGER NOT NULL DEFAULT 0,
      features TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      expires_at TEXT,
      cancelled_at TEXT,
      trial_ends_at TEXT,
      notes TEXT,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_sub_user ON user_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sub_status ON user_subscriptions(status);

    CREATE TABLE IF NOT EXISTS user_balances (
      user_id TEXT PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      total_deposited_usd REAL NOT NULL DEFAULT 0,
      total_consumed_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS balance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      reference_type TEXT,
      reference_id TEXT,
      actor_id TEXT,
      source TEXT NOT NULL DEFAULT 'system_adjustment',
      operator_type TEXT NOT NULL DEFAULT 'system',
      notes TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bal_tx_user ON balance_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_bal_tx_created ON balance_transactions(created_at);

    CREATE TABLE IF NOT EXISTS monthly_usage (
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month)
    );

    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value_usd REAL,
      plan_id TEXT,
      duration_days INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT NOT NULL,
      notes TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS redeem_code_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redeemed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_redeem_usage_user ON redeem_code_usage(user_id);

    CREATE TABLE IF NOT EXISTS billing_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bill_audit_user ON billing_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_bill_audit_created ON billing_audit_log(created_at);

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);
  `);

  // Token usage tracking tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_records(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_group_date ON usage_records(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model_date ON usage_records(model, created_at);

    CREATE TABLE IF NOT EXISTS usage_daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, model, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_user_date ON usage_daily_summary(user_id, date);

    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY,
      monthly_cost_limit_usd REAL NOT NULL DEFAULT -1,
      monthly_token_limit INTEGER NOT NULL DEFAULT -1,
      daily_cost_limit_usd REAL NOT NULL DEFAULT -1,
      daily_request_limit INTEGER NOT NULL DEFAULT -1,
      billing_cycle_start TEXT,
      subscription_tier TEXT,
      subscription_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Lightweight migrations for existing DBs
  ensureColumn('users', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'disable_reason', 'TEXT');
  ensureColumn('users', 'notes', 'TEXT');
  ensureColumn('users', 'deleted_at', 'TEXT');
  ensureColumn('invite_codes', 'permission_template', 'TEXT');
  ensureColumn('invite_codes', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'avatar_emoji', 'TEXT');
  ensureColumn('users', 'avatar_color', 'TEXT');
  ensureColumn(
    'registered_groups',
    'execution_mode',
    "TEXT DEFAULT 'container'",
  );
  ensureColumn('registered_groups', 'runtime', 'TEXT');
  ensureColumn('registered_groups', 'custom_cwd', 'TEXT');
  ensureColumn('registered_groups', 'init_source_path', 'TEXT');
  ensureColumn('registered_groups', 'init_git_url', 'TEXT');
  ensureColumn('messages', 'attachments', 'TEXT');
  ensureColumn('messages', 'source_jid', 'TEXT');
  ensureColumn('registered_groups', 'created_by', 'TEXT');
  ensureColumn('registered_groups', 'is_home', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'avatar_url', 'TEXT');
  ensureColumn('users', 'ai_name', 'TEXT');
  ensureColumn('users', 'ai_avatar_emoji', 'TEXT');
  ensureColumn('users', 'ai_avatar_color', 'TEXT');
  ensureColumn('users', 'ai_avatar_url', 'TEXT');
  ensureColumn('scheduled_tasks', 'created_by', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_type', "TEXT DEFAULT 'agent'");
  ensureColumn('scheduled_tasks', 'script_command', 'TEXT');
  ensureColumn('scheduled_tasks', 'notify_channels', 'TEXT');
  ensureColumn('registered_groups', 'selected_skills', 'TEXT');
  ensureColumn('sessions', 'agent_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agents', 'kind', "TEXT NOT NULL DEFAULT 'task'");
  ensureColumn('registered_groups', 'target_agent_id', 'TEXT');
  ensureColumn('registered_groups', 'target_main_jid', 'TEXT');
  ensureColumn(
    'registered_groups',
    'reply_policy',
    "TEXT DEFAULT 'source_only'",
  );
  ensureColumn('registered_groups', 'require_mention', 'INTEGER DEFAULT 0');
  ensureColumn('registered_groups', 'mcp_mode', "TEXT DEFAULT 'inherit'");
  ensureColumn('registered_groups', 'selected_mcps', 'TEXT');
  ensureColumn('registered_groups', 'activation_mode', "TEXT DEFAULT 'auto'");
  ensureColumn('messages', 'token_usage', 'TEXT');
  ensureColumn('messages', 'turn_id', 'TEXT');
  ensureColumn('messages', 'session_id', 'TEXT');
  ensureColumn('messages', 'sdk_message_uuid', 'TEXT');
  ensureColumn('messages', 'source_kind', 'TEXT');
  ensureColumn('messages', 'finalization_reason', 'TEXT');

  // Add index on target_agent_id for fast lookup of IM bindings
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_agent ON registered_groups(target_agent_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_main ON registered_groups(target_main_jid)',
  );

  // Migration: remove UNIQUE constraint from registered_groups.folder
  // Multiple groups (web:main + feishu chats) share folder='main' by design.
  // The old UNIQUE constraint caused INSERT OR REPLACE to silently delete
  // the conflicting row, making web:main and feishu groups mutually exclusive.
  const hasUniqueFolder =
    (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sqlite_master
         WHERE type='index' AND tbl_name='registered_groups'
         AND name='sqlite_autoindex_registered_groups_2'`,
        )
        .get() as { cnt: number }
    ).cnt > 0;
  if (hasUniqueFolder) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE registered_groups_new (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          execution_mode TEXT DEFAULT 'container',
          runtime TEXT,
          custom_cwd TEXT,
          init_source_path TEXT,
          init_git_url TEXT,
          created_by TEXT,
          is_home INTEGER DEFAULT 0
        );
        INSERT INTO registered_groups_new SELECT jid, name, folder, added_at, container_config, execution_mode, NULL, custom_cwd, NULL, NULL, NULL, 0 FROM registered_groups;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_new RENAME TO registered_groups;
      `);
    })();
  }

  // v19→v20 migration: add token_usage column to messages
  ensureColumn('messages', 'token_usage', 'TEXT');
  assertSchema('messages', [
    'id',
    'chat_jid',
    'source_jid',
    'sender',
    'sender_name',
    'content',
    'timestamp',
    'is_from_me',
    'attachments',
    'token_usage',
  ]);
  assertSchema('scheduled_tasks', [
    'id',
    'group_folder',
    'chat_jid',
    'prompt',
    'schedule_type',
    'schedule_value',
    'context_mode',
    'next_run',
    'last_run',
    'last_result',
    'status',
    'created_at',
    'created_by',
  ]);
  assertSchema(
    'registered_groups',
    [
      'jid',
      'name',
      'folder',
      'added_at',
      'container_config',
      'execution_mode',
      'runtime',
      'custom_cwd',
      'init_source_path',
      'init_git_url',
      'created_by',
      'is_home',
      'selected_skills',
      'target_agent_id',
      'target_main_jid',
      'reply_policy',
    ],
    ['trigger_pattern', 'requires_trigger'],
  );

  assertSchema('users', [
    'id',
    'username',
    'password_hash',
    'display_name',
    'role',
    'status',
    'permissions',
    'must_change_password',
    'disable_reason',
    'notes',
    'avatar_emoji',
    'avatar_color',
    'avatar_url',
    'ai_name',
    'ai_avatar_emoji',
    'ai_avatar_color',
    'ai_avatar_url',
    'created_at',
    'updated_at',
    'last_login_at',
    'deleted_at',
  ]);
  assertSchema('user_sessions', [
    'id',
    'user_id',
    'ip_address',
    'user_agent',
    'created_at',
    'expires_at',
    'last_active_at',
  ]);
  assertSchema('invite_codes', [
    'code',
    'created_by',
    'role',
    'permission_template',
    'permissions',
    'max_uses',
    'used_count',
    'expires_at',
    'created_at',
  ]);
  assertSchema('auth_audit_log', [
    'id',
    'event_type',
    'username',
    'actor_username',
    'ip_address',
    'user_agent',
    'details',
    'created_at',
  ]);

  // Store schema version after all migrations complete
  // Migrate existing web groups: assign to first admin
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid LIKE 'web:%' AND folder != 'main' AND created_by IS NULL
  `);

  // Backfill owner for legacy web:main if missing.
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid = 'web:main' AND created_by IS NULL
  `);

  // Backfill created_by for feishu/telegram groups by matching sibling groups in the same folder.
  // Only backfill when the folder has exactly one distinct owner; otherwise keep NULL
  // to avoid misrouting in ambiguous folders (e.g., shared admin main).
  db.exec(`
    UPDATE registered_groups
    SET created_by = (
      SELECT MIN(rg2.created_by)
      FROM registered_groups rg2
      WHERE rg2.folder = registered_groups.folder
        AND rg2.created_by IS NOT NULL
    )
    WHERE (jid LIKE 'feishu:%' OR jid LIKE 'telegram:%')
      AND created_by IS NULL
      AND (
        SELECT COUNT(DISTINCT rg3.created_by)
        FROM registered_groups rg3
        WHERE rg3.folder = registered_groups.folder
          AND rg3.created_by IS NOT NULL
      ) = 1
  `);

  // v13 migration: mark existing web:main group as is_home=1
  db.exec(`
    UPDATE registered_groups SET is_home = 1
    WHERE jid = 'web:main' AND folder = 'main' AND is_home = 0
  `);

  // v15 migration: backfill group_members for existing web groups
  const currentVersion = getRouterStateInternal('schema_version');
  if (!currentVersion || parseInt(currentVersion, 10) < 15) {
    db.transaction(() => {
      // Backfill owner records for all web groups with created_by set
      const webGroups = db
        .prepare(
          "SELECT DISTINCT folder, created_by FROM registered_groups WHERE jid LIKE 'web:%' AND created_by IS NOT NULL",
        )
        .all() as Array<{ folder: string; created_by: string }>;
      for (const g of webGroups) {
        db.prepare(
          `INSERT OR IGNORE INTO group_members (group_folder, user_id, role, added_at, added_by)
           VALUES (?, ?, 'owner', ?, ?)`,
        ).run(g.folder, g.created_by, new Date().toISOString(), g.created_by);
      }
    })();
  }

  // v16→v17 migration: rebuild sessions table with composite primary key
  // Old PK was (group_folder), which cannot store multiple agent sessions per folder.
  // New PK is (group_folder, COALESCE(agent_id, '')) to support per-agent sessions.
  const curVer = getRouterStateInternal('schema_version');
  if (curVer && parseInt(curVer, 10) < 17) {
    db.transaction(() => {
      // Check if the old table has single-column PK by inspecting table_info
      const pkCols = (
        db.prepare("PRAGMA table_info('sessions')").all() as Array<{
          name: string;
          pk: number;
        }>
      ).filter((c) => c.pk > 0);
      // Old schema: single PK column 'group_folder'. New schema: composite PK needs rebuild.
      if (pkCols.length === 1 && pkCols[0].name === 'group_folder') {
        db.exec(`
          CREATE TABLE sessions_new (
            group_folder TEXT NOT NULL,
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (group_folder, agent_id)
          );
          INSERT OR IGNORE INTO sessions_new (group_folder, session_id, agent_id)
            SELECT group_folder, session_id, COALESCE(agent_id, '') FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
        `);
      }
    })();
  }

  ensureColumn('sessions', 'runtime', 'TEXT');

  // v22: Fix target_main_jid that used folder-based JID (web:${folder})
  // instead of actual registered group JID (web:${uuid}).
  // Only affects non-home workspaces where folder != uuid.
  if (curVer && parseInt(curVer, 10) < 22) {
    const rows = db
      .prepare(
        "SELECT jid, target_main_jid FROM registered_groups WHERE target_main_jid IS NOT NULL AND target_main_jid != ''",
      )
      .all() as Array<{ jid: string; target_main_jid: string }>;
    for (const row of rows) {
      const targetJid = row.target_main_jid;
      // Check if target_main_jid is a real registered group JID
      const exists = db
        .prepare('SELECT 1 FROM registered_groups WHERE jid = ?')
        .get(targetJid);
      if (exists) continue;
      // Not a valid JID — try to resolve via folder
      if (!targetJid.startsWith('web:')) continue;
      const folder = targetJid.slice(4);
      const candidates = db
        .prepare(
          "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%'",
        )
        .all(folder) as Array<{ jid: string }>;
      if (candidates.length === 1) {
        db.prepare(
          'UPDATE registered_groups SET target_main_jid = ? WHERE jid = ?',
        ).run(candidates[0].jid, row.jid);
      }
    }
  }

  // v23→v24 migration: billing system initialization
  ensureColumn('users', 'subscription_plan_id', 'TEXT');
  const v24Ver = getRouterStateInternal('schema_version');
  if (!v24Ver || parseInt(v24Ver, 10) < 24) {
    db.transaction(() => {
      // Ensure a default free plan exists
      const existingDefault = db
        .prepare('SELECT id FROM billing_plans WHERE is_default = 1')
        .get();
      if (!existingDefault) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO billing_plans (id, name, description, tier, monthly_cost_usd, allow_overage, features, is_default, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run('free', '免费版', '基础免费套餐', 0, 0, 0, '[]', 1, 1, now, now);
      }

      // Initialize balances for all existing users
      const users = db
        .prepare("SELECT id FROM users WHERE status != 'deleted'")
        .all() as Array<{ id: string }>;
      const now = new Date().toISOString();
      for (const u of users) {
        db.prepare(
          'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
        ).run(u.id, now);
      }

      // Create active subscriptions for existing users → free plan
      const freePlan = db
        .prepare('SELECT id FROM billing_plans WHERE is_default = 1')
        .get() as { id: string } | undefined;
      if (freePlan) {
        for (const u of users) {
          const existing = db
            .prepare(
              "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
            )
            .get(u.id);
          if (!existing) {
            const subId = `sub_${u.id}_${Date.now()}`;
            db.prepare(
              `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
               VALUES (?, ?, ?, 'active', ?, ?)`,
            ).run(subId, u.id, freePlan.id, now, now);
          }
        }
      }
    })();
  }

  // v24→v25 migration: billing system enhancement (daily/weekly quotas, rate_multiplier, trial)
  ensureColumn('billing_plans', 'daily_cost_quota', 'REAL');
  ensureColumn('billing_plans', 'weekly_cost_quota', 'REAL');
  ensureColumn('billing_plans', 'daily_token_quota', 'INTEGER');
  ensureColumn('billing_plans', 'weekly_token_quota', 'INTEGER');
  ensureColumn('billing_plans', 'rate_multiplier', 'REAL NOT NULL DEFAULT 1.0');
  ensureColumn('billing_plans', 'trial_days', 'INTEGER');
  ensureColumn('billing_plans', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('billing_plans', 'display_price', 'TEXT');
  ensureColumn('billing_plans', 'highlight', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('user_subscriptions', 'trial_ends_at', 'TEXT');
  ensureColumn('user_subscriptions', 'notes', 'TEXT');
  ensureColumn('redeem_codes', 'batch_id', 'TEXT');

  // v25→v26 migration: cost_usd on messages + idempotency key for balance transactions
  ensureColumn('messages', 'cost_usd', 'REAL');

  // idempotency key for balance transactions
  ensureColumn('balance_transactions', 'idempotency_key', 'TEXT');
  ensureColumn(
    'balance_transactions',
    'source',
    "TEXT NOT NULL DEFAULT 'system_adjustment'",
  );
  ensureColumn(
    'balance_transactions',
    'operator_type',
    "TEXT NOT NULL DEFAULT 'system'",
  );
  ensureColumn('balance_transactions', 'notes', 'TEXT');
  // Create unique index only if it doesn't exist
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bal_tx_idempotency ON balance_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );

  // v26→v27 migration: wallet-first commercialization baseline
  const v27Ver = getRouterStateInternal('schema_version');
  if (!v27Ver || parseInt(v27Ver, 10) < 27) {
    db.transaction(() => {
      const now = new Date().toISOString();
      const users = db
        .prepare(
          "SELECT id, role FROM users WHERE status != 'deleted' AND role != 'admin'",
        )
        .all() as Array<{ id: string; role: UserRole }>;
      for (const user of users) {
        db.prepare(
          `INSERT OR IGNORE INTO user_balances (
            user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at
          ) VALUES (?, 0, 0, 0, ?)`,
        ).run(user.id, now);
        db.prepare(
          `UPDATE user_balances
           SET balance_usd = 0, total_deposited_usd = 0, total_consumed_usd = 0, updated_at = ?
           WHERE user_id = ?`,
        ).run(now, user.id);

        const hasOpening = db
          .prepare(
            "SELECT 1 FROM balance_transactions WHERE user_id = ? AND source = 'migration_opening' LIMIT 1",
          )
          .get(user.id);
        if (!hasOpening) {
          db.prepare(
            `INSERT INTO balance_transactions (
              user_id, type, amount_usd, balance_after, description, reference_type,
              reference_id, actor_id, source, operator_type, notes, idempotency_key, created_at
            ) VALUES (?, 'adjustment', 0, 0, ?, NULL, NULL, NULL, 'migration_opening', 'system', ?, NULL, ?)`,
          ).run(
            user.id,
            '商业化计费上线初始化',
            '上线迁移：普通用户默认余额归零，需充值后使用',
            now,
          );
        }
      }
    })();
  }

  // v27→v28: Token usage tables + history migration
  const v28Check = getRouterStateInternal('schema_version');
  if (!v28Check || parseInt(v28Check, 10) < 28) {
    db.transaction(() => {
      // Count messages with token_usage for logging
      const countBefore = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM messages WHERE token_usage IS NOT NULL AND json_extract(token_usage, '$.modelUsage') IS NOT NULL",
          )
          .get() as { cnt: number }
      ).cnt;

      // Migrate from messages.token_usage modelUsage into usage_records
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          COALESCE(jme.key, 'unknown'),
          COALESCE(json_extract(jme.value, '$.inputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.outputTokens'), 0),
          0, 0,
          COALESCE(json_extract(jme.value, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          JOIN json_each(json_extract(m.token_usage, '$.modelUsage')) jme
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND json_extract(m.token_usage, '$.modelUsage') IS NOT NULL
      `);

      // Migrate messages without modelUsage (legacy) using root-level fields
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          'legacy-unknown',
          COALESCE(json_extract(m.token_usage, '$.inputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.outputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheReadInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheCreationInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND (json_extract(m.token_usage, '$.modelUsage') IS NULL
               OR json_type(json_extract(m.token_usage, '$.modelUsage')) != 'object')
      `);

      // Build daily summary from usage_records
      db.exec(`
        INSERT OR REPLACE INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        SELECT
          user_id, model, date(created_at, 'localtime'),
          SUM(input_tokens), SUM(output_tokens),
          SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
          SUM(cost_usd), COUNT(*), datetime('now')
        FROM usage_records
        GROUP BY user_id, model, date(created_at, 'localtime')
      `);

      const countAfter = (
        db.prepare('SELECT COUNT(*) as cnt FROM usage_records').get() as {
          cnt: number;
        }
      ).cnt;
      logger.info(
        { countBefore, countAfter },
        'Token usage migration v27→v28 completed',
      );
    })();
  }

  // v29 → v30: Add last_im_jid to agents table (#225)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'last_im_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN last_im_jid TEXT');
  }

  // v31 → v32: Add spawned_from_jid to agents table (spawn parallel tasks)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'spawned_from_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN spawned_from_jid TEXT');
  }

  const SCHEMA_VERSION = '33';
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run('schema_version', SCHEMA_VERSION);
}

export function closeDatabase(): void {
  closeDatabaseConnection();
}

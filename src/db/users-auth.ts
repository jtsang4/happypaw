import { getDefaultPermissions, normalizePermissions } from '../permissions.js';
import type {
  AuthAuditLog,
  AuthEventType,
  InviteCode,
  InviteCodeWithCreator,
  Permission,
  PermissionTemplateKey,
  User,
  UserPublic,
  UserRole,
  UserSession,
  UserSessionWithUser,
  UserStatus,
} from '../types.js';

import { getDefaultBillingPlan } from './billing.js';
import { db, stmts } from './shared.js';

function parseUserRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'member';
}

function parseUserStatus(value: unknown): UserStatus {
  if (value === 'deleted') return 'deleted';
  if (value === 'disabled') return 'disabled';
  return 'active';
}

function parsePermissionsFromDb(raw: unknown, role: UserRole): Permission[] {
  if (typeof raw === 'string') {
    try {
      const parsed = normalizePermissions(JSON.parse(raw));
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore and fall back to role defaults
    }
  }
  return getDefaultPermissions(role);
}

function parseJsonDetails(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapUserRow(row: Record<string, unknown>): User {
  const role = parseUserRole(row.role);
  const status = parseUserStatus(row.status);
  return {
    id: String(row.id),
    username: String(row.username),
    password_hash: String(row.password_hash),
    display_name: String(row.display_name ?? ''),
    role,
    status,
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
    disable_reason:
      typeof row.disable_reason === 'string' ? row.disable_reason : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    avatar_emoji:
      typeof row.avatar_emoji === 'string' ? row.avatar_emoji : null,
    avatar_color:
      typeof row.avatar_color === 'string' ? row.avatar_color : null,
    avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    ai_name: typeof row.ai_name === 'string' ? row.ai_name : null,
    ai_avatar_emoji:
      typeof row.ai_avatar_emoji === 'string' ? row.ai_avatar_emoji : null,
    ai_avatar_color:
      typeof row.ai_avatar_color === 'string' ? row.ai_avatar_color : null,
    ai_avatar_url:
      typeof row.ai_avatar_url === 'string' ? row.ai_avatar_url : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_login_at:
      typeof row.last_login_at === 'string' ? row.last_login_at : null,
    deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
  };
}

function toUserPublic(user: User, lastActiveAt: string | null): UserPublic {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    permissions: user.permissions,
    must_change_password: user.must_change_password,
    disable_reason: user.disable_reason,
    notes: user.notes,
    avatar_emoji: user.avatar_emoji,
    avatar_color: user.avatar_color,
    avatar_url: user.avatar_url,
    ai_name: user.ai_name,
    ai_avatar_emoji: user.ai_avatar_emoji,
    ai_avatar_color: user.ai_avatar_color,
    ai_avatar_url: user.ai_avatar_url,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
    last_active_at: lastActiveAt,
    deleted_at: user.deleted_at,
  };
}

// --- Users ---

export interface CreateUserInput {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  permissions?: Permission[];
  must_change_password?: boolean;
  disable_reason?: string | null;
  notes?: string | null;
  last_login_at?: string | null;
  deleted_at?: string | null;
}

function initializeBillingForUser(
  userId: string,
  role: UserRole,
  createdAt: string,
): void {
  const now = createdAt || new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
  ).run(userId, now);

  if (role === 'admin') return;

  const defaultPlan = getDefaultBillingPlan();
  if (!defaultPlan) return;

  const activeSubscription = db
    .prepare(
      "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
    )
    .get(userId) as { id: string } | undefined;
  if (activeSubscription) return;

  const subId = `sub_${userId}_${Date.now()}`;
  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(subId, userId, defaultPlan.id, now, now);
  db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
    defaultPlan.id,
    userId,
  );

  const hasOpening = db
    .prepare(
      "SELECT 1 FROM balance_transactions WHERE user_id = ? AND source = 'migration_opening' LIMIT 1",
    )
    .get(userId);
  if (!hasOpening) {
    db.prepare(
      `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, idempotency_key, created_at
      ) VALUES (?, 'adjustment', 0, 0, ?, NULL, NULL, NULL, 'migration_opening', 'system', ?, NULL, ?)`,
    ).run(
      userId,
      '用户钱包初始化',
      '新用户默认余额为 0，需管理员充值或兑换后方可消费',
      now,
    );
  }
}

export function createUser(user: CreateUserInput): void {
  const permissions = normalizePermissions(
    user.permissions ?? getDefaultPermissions(user.role),
  );
  db.prepare(
    `INSERT INTO users (
      id, username, password_hash, display_name, role, status, permissions, must_change_password,
      disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.username,
    user.password_hash,
    user.display_name,
    user.role,
    user.status,
    JSON.stringify(permissions),
    user.must_change_password ? 1 : 0,
    user.disable_reason ?? null,
    user.notes ?? null,
    user.created_at,
    user.updated_at,
    user.last_login_at ?? null,
    user.deleted_at ?? null,
  );
  initializeBillingForUser(user.id, user.role, user.created_at);
}

export type CreateInitialAdminResult =
  | { ok: true }
  | { ok: false; reason: 'already_initialized' | 'username_taken' };

export function createInitialAdminUser(
  user: CreateUserInput,
): CreateInitialAdminResult {
  const tx = db.transaction(
    (input: CreateUserInput): CreateInitialAdminResult => {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      };
      if (row.count > 0) return { ok: false, reason: 'already_initialized' };
      createUser(input);
      return { ok: true };
    },
  );

  try {
    return tx(user);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getUserById(id: string): User | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapUserRow(row) : undefined;
}

export function getUserByUsername(username: string): User | undefined {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as Record<string, unknown> | undefined;
  return row ? mapUserRow(row) : undefined;
}

export interface ListUsersOptions {
  query?: string;
  role?: UserRole | 'all';
  status?: UserStatus | 'all';
  page?: number;
  pageSize?: number;
}

export interface ListUsersResult {
  users: UserPublic[];
  total: number;
  page: number;
  pageSize: number;
}

export function listUsers(options: ListUsersOptions = {}): ListUsersResult {
  const role = options.role && options.role !== 'all' ? options.role : null;
  const status =
    options.status && options.status !== 'all' ? options.status : null;
  const query = options.query?.trim() || '';
  const page = Math.max(1, Math.floor(options.page || 1));
  const pageSize = Math.min(
    200,
    Math.max(1, Math.floor(options.pageSize || 50)),
  );
  const offset = (page - 1) * pageSize;

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (role) {
    whereParts.push('u.role = ?');
    params.push(role);
  }
  if (status) {
    whereParts.push('u.status = ?');
    params.push(status);
  }
  if (query) {
    whereParts.push(
      "(u.username LIKE ? OR u.display_name LIKE ? OR COALESCE(u.notes, '') LIKE ?)",
    );
    const like = `%${query}%`;
    params.push(like, like, like);
  }

  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM users u ${whereClause}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(
      `
      SELECT u.*, MAX(s.last_active_at) AS last_active_at
      FROM users u
      LEFT JOIN user_sessions s ON s.user_id = u.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY
        CASE u.status
          WHEN 'active' THEN 0
          WHEN 'disabled' THEN 1
          ELSE 2
        END,
        u.created_at DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, pageSize, offset) as Array<Record<string, unknown>>;

  return {
    users: rows.map((row) => {
      const user = mapUserRow(row);
      const lastActiveAt =
        typeof row.last_active_at === 'string' ? row.last_active_at : null;
      return toUserPublic(user, lastActiveAt);
    }),
    total: totalRow.count,
    page,
    pageSize,
  };
}

export function getAllUsers(): UserPublic[] {
  return listUsers({ role: 'all', status: 'all', page: 1, pageSize: 1000 })
    .users;
}

export function getUserCount(includeDeleted = false): number {
  const row = includeDeleted
    ? (db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      })
    : (db
        .prepare('SELECT COUNT(*) as count FROM users WHERE status != ?')
        .get('deleted') as { count: number });
  return row.count;
}

export function getActiveAdminCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM users
       WHERE role = 'admin' AND status = 'active'`,
    )
    .get() as { count: number };
  return row.count;
}

export function updateUserFields(
  id: string,
  updates: Partial<
    Pick<
      User,
      | 'username'
      | 'display_name'
      | 'role'
      | 'status'
      | 'password_hash'
      | 'last_login_at'
      | 'permissions'
      | 'must_change_password'
      | 'disable_reason'
      | 'notes'
      | 'avatar_emoji'
      | 'avatar_color'
      | 'avatar_url'
      | 'ai_name'
      | 'ai_avatar_emoji'
      | 'ai_avatar_color'
      | 'ai_avatar_url'
      | 'deleted_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.username !== undefined) {
    fields.push('username = ?');
    values.push(updates.username);
  }
  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.role !== undefined) {
    fields.push('role = ?');
    values.push(updates.role);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.password_hash !== undefined) {
    fields.push('password_hash = ?');
    values.push(updates.password_hash);
  }
  if (updates.last_login_at !== undefined) {
    fields.push('last_login_at = ?');
    values.push(updates.last_login_at);
  }
  if (updates.permissions !== undefined) {
    fields.push('permissions = ?');
    values.push(JSON.stringify(normalizePermissions(updates.permissions)));
  }
  if (updates.must_change_password !== undefined) {
    fields.push('must_change_password = ?');
    values.push(updates.must_change_password ? 1 : 0);
  }
  if (updates.disable_reason !== undefined) {
    fields.push('disable_reason = ?');
    values.push(updates.disable_reason);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes);
  }
  if (updates.avatar_emoji !== undefined) {
    fields.push('avatar_emoji = ?');
    values.push(updates.avatar_emoji);
  }
  if (updates.avatar_color !== undefined) {
    fields.push('avatar_color = ?');
    values.push(updates.avatar_color);
  }
  if (updates.avatar_url !== undefined) {
    fields.push('avatar_url = ?');
    values.push(updates.avatar_url);
  }
  if (updates.ai_name !== undefined) {
    fields.push('ai_name = ?');
    values.push(updates.ai_name);
  }
  if (updates.ai_avatar_emoji !== undefined) {
    fields.push('ai_avatar_emoji = ?');
    values.push(updates.ai_avatar_emoji);
  }
  if (updates.ai_avatar_color !== undefined) {
    fields.push('ai_avatar_color = ?');
    values.push(updates.ai_avatar_color);
  }
  if (updates.ai_avatar_url !== undefined) {
    fields.push('ai_avatar_url = ?');
    values.push(updates.ai_avatar_url);
  }
  if (updates.deleted_at !== undefined) {
    fields.push('deleted_at = ?');
    values.push(updates.deleted_at);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteUser(id: string): void {
  const now = new Date().toISOString();
  const tx = db.transaction((userId: string) => {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
    db.prepare(
      `UPDATE users
       SET status = 'deleted', deleted_at = ?, disable_reason = COALESCE(disable_reason, 'deleted_by_admin'), updated_at = ?
       WHERE id = ?`,
    ).run(now, now, userId);
  });
  tx(id);
}

export function restoreUser(id: string): void {
  db.prepare(
    `UPDATE users
     SET status = 'disabled', deleted_at = NULL, disable_reason = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

// --- User Sessions ---

export function createUserSession(session: UserSession): void {
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.user_id,
    session.ip_address,
    session.user_agent,
    session.created_at,
    session.expires_at,
    session.last_active_at,
  );
}

export function getSessionWithUser(
  sessionId: string,
): UserSessionWithUser | undefined {
  const row = stmts().getSessionWithUser.get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  const role = parseUserRole(row.role);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    ip_address: typeof row.ip_address === 'string' ? row.ip_address : null,
    user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    last_active_at: String(row.last_active_at),
    username: String(row.username),
    role,
    status: parseUserStatus(row.status),
    display_name: String(row.display_name ?? ''),
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
  };
}

export function getUserSessions(userId: string): UserSession[] {
  return db
    .prepare(
      `SELECT * FROM user_sessions WHERE user_id = ? ORDER BY last_active_at DESC`,
    )
    .all(userId) as UserSession[];
}

export function deleteUserSession(sessionId: string): void {
  stmts().deleteSession.run(sessionId);
}

export function deleteUserSessionsByUserId(userId: string): void {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
}

export function updateSessionLastActive(sessionId: string): void {
  stmts().updateSessionLastActive.run(new Date().toISOString(), sessionId);
}

export function getExpiredSessionIds(): string[] {
  const now = new Date().toISOString();
  return (stmts().getExpiredSessionIds.all(now) as { id: string }[]).map(
    (r) => r.id,
  );
}

export function deleteExpiredSessions(): number {
  const now = new Date().toISOString();
  const result = db
    .prepare('DELETE FROM user_sessions WHERE expires_at < ?')
    .run(now);
  return result.changes;
}

// --- Invite Codes ---

export function createInviteCode(invite: InviteCode): void {
  const permissions = normalizePermissions(invite.permissions);
  db.prepare(
    `INSERT INTO invite_codes (code, created_by, role, permission_template, permissions, max_uses, used_count, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invite.code,
    invite.created_by,
    invite.role,
    invite.permission_template ?? null,
    JSON.stringify(permissions),
    invite.max_uses,
    invite.used_count,
    invite.expires_at,
    invite.created_at,
  );
}

export function getInviteCode(code: string): InviteCode | undefined {
  const row = db
    .prepare('SELECT * FROM invite_codes WHERE code = ?')
    .get(code) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const role = parseUserRole(row.role);
  return {
    code: String(row.code),
    created_by: String(row.created_by),
    role,
    permission_template:
      typeof row.permission_template === 'string'
        ? (row.permission_template as PermissionTemplateKey)
        : null,
    permissions: parsePermissionsFromDb(row.permissions, role),
    max_uses: Number(row.max_uses),
    used_count: Number(row.used_count),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_at: String(row.created_at),
  };
}

export type RegisterUserWithInviteResult =
  | { ok: true; role: UserRole; permissions: Permission[] }
  | {
      ok: false;
      reason:
        | 'invalid_or_expired_invite'
        | 'invite_exhausted'
        | 'username_taken';
    };

export function registerUserWithInvite(input: {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  invite_code: string;
  created_at: string;
  updated_at: string;
}): RegisterUserWithInviteResult {
  const tx = db.transaction(
    (params: typeof input): RegisterUserWithInviteResult => {
      const inviteRow = db
        .prepare(
          `SELECT code, role, permissions, max_uses, expires_at
         FROM invite_codes
         WHERE code = ?`,
        )
        .get(params.invite_code) as Record<string, unknown> | undefined;

      if (!inviteRow) return { ok: false, reason: 'invalid_or_expired_invite' };
      const inviteRole = parseUserRole(inviteRow.role);
      const invitePermissions = parsePermissionsFromDb(
        inviteRow.permissions,
        inviteRole,
      );
      const inviteExpiresAt =
        typeof inviteRow.expires_at === 'string' ? inviteRow.expires_at : null;

      if (inviteExpiresAt) {
        const expiresAt = Date.parse(inviteExpiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
          return { ok: false, reason: 'invalid_or_expired_invite' };
        }
      }

      const existing = db
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(params.username) as { id: string } | undefined;
      if (existing) return { ok: false, reason: 'username_taken' };

      const inviteUsage = db
        .prepare(
          `UPDATE invite_codes
         SET used_count = used_count + 1
         WHERE code = ?
           AND (max_uses = 0 OR used_count < max_uses)`,
        )
        .run(params.invite_code);
      if (inviteUsage.changes === 0) {
        return { ok: false, reason: 'invite_exhausted' };
      }

      const permissions = normalizePermissions(invitePermissions);
      db.prepare(
        `INSERT INTO users (
        id, username, password_hash, display_name, role, status, permissions, must_change_password,
        disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.id,
        params.username,
        params.password_hash,
        params.display_name,
        inviteRole,
        'active',
        JSON.stringify(permissions),
        0,
        null,
        null,
        params.created_at,
        params.updated_at,
        null,
        null,
      );
      initializeBillingForUser(params.id, inviteRole, params.created_at);

      return { ok: true, role: inviteRole, permissions };
    },
  );

  try {
    return tx(input);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export type RegisterUserWithoutInviteResult =
  | { ok: true; role: UserRole; permissions: Permission[] }
  | { ok: false; reason: 'username_taken' };

export function registerUserWithoutInvite(input: {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}): RegisterUserWithoutInviteResult {
  const role: UserRole = 'member';
  const permissions: Permission[] = [];

  try {
    db.prepare(
      `INSERT INTO users (
        id, username, password_hash, display_name, role, status, permissions, must_change_password,
        disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.username,
      input.password_hash,
      input.display_name,
      role,
      'active',
      JSON.stringify(permissions),
      0,
      null,
      null,
      input.created_at,
      input.updated_at,
      null,
      null,
    );
    initializeBillingForUser(input.id, role, input.created_at);
    return { ok: true, role, permissions };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getAllInviteCodes(): InviteCodeWithCreator[] {
  const rows = db
    .prepare(
      `SELECT i.*, u.username as creator_username
       FROM invite_codes i
       JOIN users u ON i.created_by = u.id
       ORDER BY i.created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const role = parseUserRole(row.role);
    return {
      code: String(row.code),
      created_by: String(row.created_by),
      creator_username: String(row.creator_username),
      role,
      permission_template:
        typeof row.permission_template === 'string'
          ? (row.permission_template as PermissionTemplateKey)
          : null,
      permissions: parsePermissionsFromDb(row.permissions, role),
      max_uses: Number(row.max_uses),
      used_count: Number(row.used_count),
      expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
      created_at: String(row.created_at),
    };
  });
}

export function deleteInviteCode(code: string): void {
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
}

// --- Auth Audit Log ---

export function logAuthEvent(event: {
  event_type: AuthEventType;
  username: string;
  actor_username?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  details?: Record<string, unknown> | null;
}): void {
  db.prepare(
    `INSERT INTO auth_audit_log (event_type, username, actor_username, ip_address, user_agent, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_type,
    event.username,
    event.actor_username ?? null,
    event.ip_address ?? null,
    event.user_agent ?? null,
    event.details ? JSON.stringify(event.details) : null,
    new Date().toISOString(),
  );
}

export interface AuthAuditLogQuery {
  limit?: number;
  offset?: number;
  event_type?: AuthEventType | 'all';
  username?: string;
  actor_username?: string;
  from?: string;
  to?: string;
}

export interface AuthAuditLogPage {
  logs: AuthAuditLog[];
  total: number;
  limit: number;
  offset: number;
}

export function queryAuthAuditLogs(
  query: AuthAuditLogQuery = {},
): AuthAuditLogPage {
  const limit = Math.min(500, Math.max(1, Math.floor(query.limit || 100)));
  const offset = Math.max(0, Math.floor(query.offset || 0));

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (query.event_type && query.event_type !== 'all') {
    whereParts.push('event_type = ?');
    params.push(query.event_type);
  }
  if (query.username?.trim()) {
    whereParts.push('username LIKE ?');
    params.push(`%${query.username.trim()}%`);
  }
  if (query.actor_username?.trim()) {
    whereParts.push('actor_username LIKE ?');
    params.push(`%${query.actor_username.trim()}%`);
  }
  if (query.from) {
    whereParts.push('created_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    whereParts.push('created_at <= ?');
    params.push(query.to);
  }
  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) as count FROM auth_audit_log ${whereClause}`)
      .get(...params) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(
      `SELECT * FROM auth_audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, unknown>>;

  const logs = rows.map((row) => ({
    id: Number(row.id),
    event_type: row.event_type as AuthEventType,
    username: String(row.username),
    actor_username:
      typeof row.actor_username === 'string' ? row.actor_username : null,
    ip_address: typeof row.ip_address === 'string' ? row.ip_address : null,
    user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
    details: parseJsonDetails(row.details),
    created_at: String(row.created_at),
  }));

  return { logs, total, limit, offset };
}

export function getAuthAuditLogs(limit = 100, offset = 0): AuthAuditLog[] {
  return queryAuthAuditLogs({ limit, offset }).logs;
}

export function checkLoginRateLimitFromAudit(
  username: string,
  ip: string,
  maxAttempts: number,
  lockoutMinutes: number,
): { allowed: boolean; retryAfterSeconds?: number; attempts: number } {
  if (maxAttempts <= 0) return { allowed: true, attempts: 0 };
  const windowStart = new Date(
    Date.now() - lockoutMinutes * 60 * 1000,
  ).toISOString();
  const rows = db
    .prepare(
      `
      SELECT created_at
      FROM auth_audit_log
      WHERE event_type = 'login_failed'
        AND username = ?
        AND ip_address = ?
        AND created_at >= ?
        AND (details IS NULL OR details NOT LIKE '%"reason":"rate_limited"%')
      ORDER BY created_at ASC
      `,
    )
    .all(username, ip, windowStart) as Array<{ created_at: string }>;

  const attempts = rows.length;
  if (attempts < maxAttempts) return { allowed: true, attempts };

  const oldest = rows[0]?.created_at;
  const oldestTs = oldest ? Date.parse(oldest) : Date.now();
  const retryAt = oldestTs + lockoutMinutes * 60 * 1000;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAt - Date.now()) / 1000),
  );
  return { allowed: false, retryAfterSeconds, attempts };
}

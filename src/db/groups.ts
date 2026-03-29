import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../app/config.js';
import type { GroupMember, RegisteredGroup } from '../shared/types.js';

import { ensureChatExists } from './chats-messages.js';
import { db } from './shared.js';
import { parseGroupRow, type RegisteredGroupRow } from './group-helpers.js';

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  return parseGroupRow(row);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, added_at, container_config, execution_mode, runtime, custom_cwd, init_source_path, init_git_url, created_by, is_home, selected_skills, target_agent_id, target_main_jid, reply_policy, require_mention, activation_mode, mcp_mode, selected_mcps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.executionMode ?? 'container',
    null,
    group.customCwd ?? null,
    group.initSourcePath ?? null,
    group.initGitUrl ?? null,
    group.created_by ?? null,
    group.is_home ? 1 : 0,
    null, // selected_skills: deprecated, always null (user-level skills apply globally)
    group.target_agent_id ?? null,
    group.target_main_jid ?? null,
    group.reply_policy ?? 'source_only',
    group.require_mention === true ? 1 : 0,
    group.activation_mode ?? 'auto',
    'inherit', // mcp_mode: deprecated, always inherit (user-level MCP applies globally)
    null, // selected_mcps: deprecated, always null
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}

/** Get all JIDs that share the same folder (e.g., all JIDs with folder='main'). */
export function getJidsByFolder(folder: string): string[] {
  const rows = db
    .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
    .all(folder) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

/** Check if any registered group uses container execution mode (efficient targeted query). */
export function hasContainerModeGroups(): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM registered_groups WHERE execution_mode = 'container' OR execution_mode IS NULL LIMIT 1",
    )
    .get();
  return row !== undefined;
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = parseGroupRow(row);
  }
  return result;
}

/**
 * Get all registered groups that route to a specific conversation agent.
 * Returns array of { jid, group } for each IM group targeting the given agentId.
 */
export function getGroupsByTargetAgent(
  agentId: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE target_agent_id = ?')
    .all(agentId) as RegisteredGroupRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

/**
 * Get all registered groups that route to a specific workspace's main conversation.
 */
export function getGroupsByTargetMainJid(
  webJid: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE target_main_jid = ?')
    .all(webJid) as RegisteredGroupRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

/**
 * Find a user's home group (is_home=1 + created_by=userId).
 * For admin users, also matches web:main even if created_by differs
 * (all admins share folder=main).
 */
export function getUserHomeGroup(
  userId: string,
): (RegisteredGroup & { jid: string }) | undefined {
  // First try exact match: is_home=1 AND created_by=userId
  let row = db
    .prepare(
      'SELECT * FROM registered_groups WHERE is_home = 1 AND created_by = ?',
    )
    .get(userId) as RegisteredGroupRow | undefined;

  // Fallback for admin users: all admins share web:main (folder=main).
  // If no exact match, check if the user is an admin and web:main exists.
  if (!row) {
    const user = db
      .prepare("SELECT role FROM users WHERE id = ? AND status = 'active'")
      .get(userId) as { role: string } | undefined;
    if (user?.role === 'admin') {
      row = db
        .prepare(
          "SELECT * FROM registered_groups WHERE jid = 'web:main' AND is_home = 1",
        )
        .get() as RegisteredGroupRow | undefined;
    }
  }

  if (!row) return undefined;
  return parseGroupRow(row);
}

/**
 * Ensure a user has a home group. If not, create one.
 * Admin gets folder='main' with executionMode='host'.
 * Member gets folder='home-{userId}' with executionMode='container'.
 * Returns the JID of the home group.
 */
export function ensureUserHomeGroup(
  userId: string,
  role: 'admin' | 'member',
  username?: string,
): string {
  const existing = getUserHomeGroup(userId);
  if (existing) return existing.jid;

  const now = new Date().toISOString();
  const isAdmin = role === 'admin';
  const jid = isAdmin ? 'web:main' : `web:home-${userId}`;
  const folder = isAdmin ? 'main' : `home-${userId}`;

  // For admin: check if web:main already exists (created by another admin)
  // In that case, reuse it rather than overwriting created_by
  if (isAdmin) {
    const existingMain = getRegisteredGroup(jid);
    if (existingMain) {
      // web:main already exists.
      // Ensure is_home, created_by, and executionMode are correct for owner-based routing.
      const patched = { ...existingMain };
      let changed = false;
      if (!patched.is_home) {
        patched.is_home = true;
        changed = true;
      }
      if (!patched.created_by) {
        patched.created_by = userId;
        changed = true;
      }
      // Admin home container must use host mode
      if (patched.executionMode !== 'host') {
        patched.executionMode = 'host';
        changed = true;
      }
      if (changed) {
        setRegisteredGroup(jid, patched);
      }
      ensureChatExists(jid);
      return jid;
    }
  }

  const name = username ? `${username} Home` : isAdmin ? 'Main' : 'Home';

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: isAdmin ? 'host' : 'container',
    created_by: userId,
    is_home: true,
  };

  setRegisteredGroup(jid, group);

  // Ensure chat row exists
  ensureChatExists(jid);

  // Create user-global memory directory and initialize AGENTS.md from template
  const userGlobalDir = path.join(GROUPS_DIR, 'user-global', userId);
  fs.mkdirSync(userGlobalDir, { recursive: true });
  const userMemoryFile = path.join(userGlobalDir, 'AGENTS.md');
  if (!fs.existsSync(userMemoryFile)) {
    const templatePath = path.resolve(
      process.cwd(),
      'config',
      'global-agents-md.template.md',
    );
    if (fs.existsSync(templatePath)) {
      try {
        fs.writeFileSync(
          userMemoryFile,
          fs.readFileSync(templatePath, 'utf-8'),
          {
            flag: 'wx',
          },
        );
      } catch {
        // EEXIST race or read error — ignore
      }
    }
  }

  return jid;
}

export function deleteChatHistory(chatJid: string): void {
  const tx = db.transaction((jid: string) => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
  });
  tx(chatJid);
}

export function deleteGroupData(jid: string, folder: string): void {
  const tx = db.transaction(() => {
    // 1. 删除定时任务运行日志 + 定时任务
    db.prepare(
      'DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)',
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
    // 2. 删除成员记录
    db.prepare('DELETE FROM group_members WHERE group_folder = ?').run(folder);
    // 3. 删除注册信息
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    // 4. 删除会话
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    // 5. 删除聊天记录
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    // 6. 删除 pin 记录
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
  });
  tx();
}

// --- User pinned groups ---

export function getUserPinnedGroups(userId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT jid, pinned_at FROM user_pinned_groups WHERE user_id = ?')
    .all(userId) as Array<{ jid: string; pinned_at: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.jid] = row.pinned_at;
  return result;
}

export function pinGroup(userId: string, jid: string): string {
  const pinned_at = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO user_pinned_groups (user_id, jid, pinned_at) VALUES (?, ?, ?)',
  ).run(userId, jid, pinned_at);
  return pinned_at;
}

export function unpinGroup(userId: string, jid: string): void {
  db.prepare(
    'DELETE FROM user_pinned_groups WHERE user_id = ? AND jid = ?',
  ).run(userId, jid);
}

export function getGroupsByOwner(
  userId: string,
): Array<RegisteredGroup & { jid: string }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE created_by = ?')
    .all(userId) as RegisteredGroupRow[];

  return rows.map(parseGroupRow);
}

export function addGroupMember(
  groupFolder: string,
  userId: string,
  role: 'owner' | 'member',
  addedBy?: string,
): void {
  db.prepare(
    `INSERT INTO group_members (group_folder, user_id, role, added_at, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_folder, user_id) DO UPDATE SET
       role = CASE WHEN excluded.role = 'owner' THEN 'owner'
                   WHEN group_members.role = 'owner' THEN 'owner'
                   ELSE excluded.role END,
       added_by = COALESCE(excluded.added_by, group_members.added_by)`,
  ).run(groupFolder, userId, role, new Date().toISOString(), addedBy ?? null);
}

export function removeGroupMember(groupFolder: string, userId: string): void {
  db.prepare(
    'DELETE FROM group_members WHERE group_folder = ? AND user_id = ?',
  ).run(groupFolder, userId);
}

export function getGroupMembers(groupFolder: string): GroupMember[] {
  const rows = db
    .prepare(
      `SELECT gm.user_id, gm.role, gm.added_at, gm.added_by,
              u.username, COALESCE(u.display_name, '') as display_name
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_folder = ?
       ORDER BY gm.role DESC, gm.added_at ASC`,
    )
    .all(groupFolder) as Array<{
    user_id: string;
    role: string;
    added_at: string;
    added_by: string | null;
    username: string;
    display_name: string;
  }>;
  return rows.map((r) => ({
    user_id: r.user_id,
    role: r.role as 'owner' | 'member',
    added_at: r.added_at,
    added_by: r.added_by ?? undefined,
    username: r.username,
    display_name: r.display_name,
  }));
}

export function getGroupMemberRole(
  groupFolder: string,
  userId: string,
): 'owner' | 'member' | null {
  const row = db
    .prepare(
      'SELECT role FROM group_members WHERE group_folder = ? AND user_id = ?',
    )
    .get(groupFolder, userId) as { role: string } | undefined;
  if (!row) return null;
  return row.role as 'owner' | 'member';
}

export function getUserMemberFolders(
  userId: string,
): Array<{ group_folder: string; role: 'owner' | 'member' }> {
  const rows = db
    .prepare('SELECT group_folder, role FROM group_members WHERE user_id = ?')
    .all(userId) as Array<{ group_folder: string; role: string }>;
  return rows.map((r) => ({
    group_folder: r.group_folder,
    role: r.role as 'owner' | 'member',
  }));
}

export function isGroupShared(groupFolder: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM group_members WHERE group_folder = ?')
    .get(groupFolder) as { cnt: number };
  return row.cnt > 1;
}

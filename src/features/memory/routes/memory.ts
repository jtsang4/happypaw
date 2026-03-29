// Memory management routes and utilities

import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Variables } from '../../../web-context.js';
import { authMiddleware } from '../../../middleware/auth.js';
import {
  MemoryFileSchema,
  type MemorySource,
  type MemoryFilePayload,
  type MemorySearchHit,
} from '../../../schemas.js';
import { getAllRegisteredGroups, getUserById } from '../../../db.js';
import { logger } from '../../../logger.js';
import { GROUPS_DIR, DATA_DIR } from '../../../config.js';
import type { AuthUser } from '../../../types.js';

const memoryRoutes = new Hono<{ Variables: Variables }>();

// --- Constants ---

const USER_GLOBAL_DIR = path.join(GROUPS_DIR, 'user-global');
const MEMORY_DATA_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const MAX_MEMORY_FILE_LENGTH = 500_000;
const MEMORY_LIST_LIMIT = 500;
const MEMORY_SEARCH_LIMIT = 120;
const MEMORY_LOCATOR_PREFIX = 'memory://';
const PRIMARY_MEMORY_FILE = 'AGENTS.md';
const RUNTIME_MEMORY_DIR = '.codex';
const MEMORY_SOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
]);

// --- Utility Functions ---

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('path must be a string');
  }
  const normalized = input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid memory path');
  }
  const parts = normalized.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw new Error('Invalid memory path');
  }
  return normalized;
}

function normalizeLocator(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('locator must be a string');
  }
  const normalized = input.trim();
  if (!normalized.startsWith(MEMORY_LOCATOR_PREFIX)) {
    throw new Error('Invalid memory locator');
  }
  if (normalized.includes('\0')) {
    throw new Error('Invalid memory locator');
  }
  return normalized;
}

function encodeLocator(...segments: string[]): string {
  return `${MEMORY_LOCATOR_PREFIX}${segments
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

function decodeLocator(locator: string): string[] {
  const normalized = normalizeLocator(locator);
  const remainder = normalized.slice(MEMORY_LOCATOR_PREFIX.length);
  const parts = remainder
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (
    parts.length === 0 ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid memory locator');
  }
  return parts;
}

function workspaceScope(folder: string): MemorySource['scope'] {
  return folder === 'main' ? 'main' : 'flow';
}

function workspaceLabel(folder: string): string {
  return folder === 'main' ? '主会话' : folder;
}

function buildSessionMemoryDescriptor(
  folder: string,
  sessionParts: string[],
): Pick<MemorySource, 'locator' | 'scope' | 'kind' | 'label'> {
  const workspace = workspaceLabel(folder);
  const runtimeDirs = new Set([RUNTIME_MEMORY_DIR]);

  if (runtimeDirs.has(sessionParts[0] ?? '')) {
    const runtimePath = sessionParts.slice(1).join('/') || 'settings.json';
    return {
      locator: encodeLocator(
        'session',
        folder,
        'root',
        'managed',
        ...sessionParts.slice(1),
      ),
      scope: 'session',
      kind: 'session',
      label: `${workspace} / 自动记忆 / ${runtimePath}`,
    };
  }

  if (sessionParts[0] === 'agents' && runtimeDirs.has(sessionParts[2] ?? '')) {
    const agentId = sessionParts[1] || 'unknown-agent';
    const runtimePath = sessionParts.slice(3).join('/') || 'settings.json';
    return {
      locator: encodeLocator(
        'session',
        folder,
        'agents',
        agentId,
        'managed',
        ...sessionParts.slice(3),
      ),
      scope: 'session',
      kind: 'session',
      label: `${workspace} / Agent ${agentId} / 自动记忆 / ${runtimePath}`,
    };
  }

  if (sessionParts[0] === 'tasks' && runtimeDirs.has(sessionParts[2] ?? '')) {
    const taskId = sessionParts[1] || 'unknown-task';
    const runtimePath = sessionParts.slice(3).join('/') || 'settings.json';
    return {
      locator: encodeLocator(
        'session',
        folder,
        'tasks',
        taskId,
        'managed',
        ...sessionParts.slice(3),
      ),
      scope: 'session',
      kind: 'session',
      label: `${workspace} / 任务 ${taskId} / 自动记忆 / ${runtimePath}`,
    };
  }

  return {
    locator: encodeLocator('session', folder, 'files', ...sessionParts),
    scope: 'session',
    kind: 'session',
    label: `${workspace} / 运行时文件 / ${sessionParts.join('/')}`,
  };
}

function toPublicLocator(relativePath: string): string {
  const parts = relativePath.split('/');

  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts[2] === 'user-global'
  ) {
    const userId = parts[3] || 'unknown-user';
    const name = parts.slice(4);
    if (name.length === 1 && name[0] === PRIMARY_MEMORY_FILE) {
      return encodeLocator('user-global', userId, 'primary');
    }
    return encodeLocator('user-global', userId, 'files', ...name);
  }

  if (parts[0] === 'data' && parts[1] === 'groups') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3);
    if (name.length === 1 && name[0] === PRIMARY_MEMORY_FILE) {
      return encodeLocator('workspace', folder, 'primary');
    }
    return encodeLocator('workspace', folder, 'files', ...name);
  }

  if (parts[0] === 'data' && parts[1] === 'memory') {
    const folder = parts[2] || 'unknown';
    return encodeLocator('workspace', folder, 'daily', ...parts.slice(3));
  }

  if (parts[0] === 'data' && parts[1] === 'sessions') {
    const folder = parts[2] || 'unknown';
    const sessionParts = parts.slice(3);
    return buildSessionMemoryDescriptor(folder, sessionParts).locator;
  }

  throw new Error('Unsupported memory path');
}

function locatorToRelativePath(locator: string): string {
  const parts = decodeLocator(locator);

  if (parts[0] === 'user-global' && parts.length >= 3) {
    const userId = parts[1];
    if (parts[2] === 'primary' && parts.length === 3) {
      return `data/groups/user-global/${userId}/${PRIMARY_MEMORY_FILE}`;
    }
    if (parts[2] === 'files' && parts.length >= 4) {
      return `data/groups/user-global/${userId}/${parts.slice(3).join('/')}`;
    }
  }

  if (parts[0] === 'workspace' && parts.length >= 3) {
    const folder = parts[1];
    if (parts[2] === 'primary' && parts.length === 3) {
      return `data/groups/${folder}/${PRIMARY_MEMORY_FILE}`;
    }
    if (parts[2] === 'files' && parts.length >= 4) {
      return `data/groups/${folder}/${parts.slice(3).join('/')}`;
    }
    if (parts[2] === 'daily' && parts.length >= 4) {
      return `data/memory/${folder}/${parts.slice(3).join('/')}`;
    }
  }

  if (parts[0] === 'session' && parts.length >= 4) {
    const folder = parts[1];
    if (parts[2] === 'root' && parts.length >= 5) {
      return `data/sessions/${folder}/${RUNTIME_MEMORY_DIR}/${parts
        .slice(4)
        .join('/')}`;
    }
    if (parts[2] === 'agents' && parts.length >= 6) {
      return `data/sessions/${folder}/agents/${parts[3]}/${RUNTIME_MEMORY_DIR}/${parts
        .slice(5)
        .join('/')}`;
    }
    if (parts[2] === 'tasks' && parts.length >= 6) {
      return `data/sessions/${folder}/tasks/${parts[3]}/${RUNTIME_MEMORY_DIR}/${parts
        .slice(5)
        .join('/')}`;
    }
    if (parts[2] === 'files' && parts.length >= 4) {
      return `data/sessions/${folder}/${parts.slice(3).join('/')}`;
    }
  }

  throw new Error('Unsupported memory locator');
}

function resolveMemoryInput(input: string): string {
  return input.startsWith(MEMORY_LOCATOR_PREFIX)
    ? locatorToRelativePath(input)
    : normalizeRelativePath(input);
}

function resolveMemoryPath(
  relativePath: string,
  user: AuthUser,
): {
  absolutePath: string;
  writable: boolean;
} {
  const absolute = path.resolve(process.cwd(), relativePath);
  const inGroups = isWithinRoot(absolute, GROUPS_DIR);
  const inMemoryData = isWithinRoot(absolute, MEMORY_DATA_DIR);
  const inSessions = isWithinRoot(absolute, SESSIONS_DIR);
  const writable = inGroups || inMemoryData;
  const readable = writable || inSessions;

  if (!readable) {
    throw new Error('Memory path out of allowed scope');
  }

  // User ownership check for non-admin
  if (user.role !== 'admin') {
    // user-global/{userId}/... — member can only access their own
    if (isWithinRoot(absolute, USER_GLOBAL_DIR)) {
      const relToUserGlobal = path.relative(USER_GLOBAL_DIR, absolute);
      const ownerUserId = relToUserGlobal.split(path.sep)[0];
      if (ownerUserId !== user.id) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/groups/{folder}/... — check group ownership
    else if (inGroups) {
      const relToGroups = path.relative(GROUPS_DIR, absolute);
      const folder = relToGroups.split(path.sep)[0];
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/memory/{folder}/... — check group ownership
    else if (inMemoryData) {
      const relToMemory = path.relative(MEMORY_DATA_DIR, absolute);
      const folder = relToMemory.split(path.sep)[0];
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/sessions/{folder}/... — check group ownership
    else if (inSessions) {
      const relToSessions = path.relative(SESSIONS_DIR, absolute);
      const folder = relToSessions.split(path.sep)[0];
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
  }

  return { absolutePath: absolute, writable };
}

/** Check if a folder belongs to the user (via registered_groups). */
function isUserOwnedFolder(
  user: { id: string; role: string },
  folder: string,
): boolean {
  if (user.role === 'admin') return true;
  if (!folder) return false;
  const groups = getAllRegisteredGroups();
  for (const group of Object.values(groups)) {
    if (group.folder === folder && group.created_by === user.id) {
      return true;
    }
  }
  return false;
}

function classifyMemorySource(
  relativePath: string,
): Pick<MemorySource, 'locator' | 'scope' | 'kind' | 'label' | 'ownerName'> {
  const parts = relativePath.split('/');
  // data/groups/user-global/{userId}/AGENTS.md
  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts[2] === 'user-global'
  ) {
    const userId = parts[3] || 'unknown';
    const name = parts.slice(4).join('/') || PRIMARY_MEMORY_FILE;
    const owner = getUserById(userId);
    const ownerLabel = owner ? owner.display_name || owner.username : userId;
    const isPrimaryMemory = name === PRIMARY_MEMORY_FILE;
    return {
      locator: isPrimaryMemory
        ? encodeLocator('user-global', userId, 'primary')
        : encodeLocator('user-global', userId, 'files', ...parts.slice(4)),
      scope: 'user-global',
      kind: 'primary',
      label: isPrimaryMemory
        ? `${ownerLabel} / 全局主记忆`
        : `${ownerLabel} / 全局记忆 / ${name}`,
      ownerName: ownerLabel,
    };
  }
  // data/groups/main/AGENTS.md
  if (relativePath === `data/groups/main/${PRIMARY_MEMORY_FILE}`) {
    return {
      locator: encodeLocator('workspace', 'main', 'primary'),
      scope: 'main',
      kind: 'primary',
      label: '主会话主记忆',
    };
  }
  // data/memory/{folder}/...
  if (parts[0] === 'data' && parts[1] === 'memory') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/') || 'memory';
    return {
      locator: encodeLocator('workspace', folder, 'daily', ...parts.slice(3)),
      scope: workspaceScope(folder),
      kind: 'note' as const,
      label: `${workspaceLabel(folder)} / 日期记忆 / ${name}`,
    };
  }
  // data/groups/{folder}/... (non user-global)
  if (parts[0] === 'data' && parts[1] === 'groups') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/');
    const isPrimaryMemory = name === PRIMARY_MEMORY_FILE;
    const kind = isPrimaryMemory ? 'primary' : 'note';
    return {
      locator: isPrimaryMemory
        ? encodeLocator('workspace', folder, 'primary')
        : encodeLocator('workspace', folder, 'files', ...parts.slice(3)),
      scope: workspaceScope(folder),
      kind,
      label: isPrimaryMemory
        ? `${workspaceLabel(folder)} / 主记忆`
        : `${workspaceLabel(folder)} / ${name}`,
    };
  }
  // data/sessions/{folder}/...
  const folder = parts[2] || 'unknown';
  return buildSessionMemoryDescriptor(folder, parts.slice(3));
}

function readMemoryFile(
  requestedPath: string,
  user: AuthUser,
): MemoryFilePayload {
  const normalized = resolveMemoryInput(requestedPath);
  const { absolutePath, writable } = resolveMemoryPath(normalized, user);
  if (!fs.existsSync(absolutePath)) {
    if (!writable) {
      throw new Error('Memory file not found');
    }
    return {
      locator: toPublicLocator(normalized),
      content: '',
      updatedAt: null,
      size: 0,
      writable,
    };
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const stat = fs.statSync(absolutePath);
  return {
    locator: toPublicLocator(normalized),
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

// 记忆路径中禁止写入的系统子目录（AGENTS.md 除外，它是主记忆文件）
const MEMORY_BLOCKED_DIRS = ['logs', '.codex', 'conversations'];

function isBlockedMemoryPath(normalizedPath: string): boolean {
  const parts = normalizedPath.split('/');
  // 路径格式: data/groups/{folder}/{subpath...} 或 data/memory/{folder}/{subpath...}
  // 检查 data/groups/{folder}/ 下的系统子目录
  if (parts[0] === 'data' && parts[1] === 'groups' && parts.length >= 4) {
    const subPath = parts[3];
    if (MEMORY_BLOCKED_DIRS.includes(subPath)) return true;
  }
  return false;
}

function writeMemoryFile(
  requestedPath: string,
  content: string,
  user: AuthUser,
): MemoryFilePayload {
  const normalized = resolveMemoryInput(requestedPath);
  const { absolutePath, writable } = resolveMemoryPath(normalized, user);
  if (!writable) {
    throw new Error('Memory file is read-only');
  }
  if (isBlockedMemoryPath(normalized)) {
    throw new Error('Cannot write to system path');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_LENGTH) {
    throw new Error('Memory file is too large');
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, absolutePath);

  const stat = fs.statSync(absolutePath);
  return {
    locator: toPublicLocator(normalized),
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

function walkFiles(
  baseDir: string,
  maxDepth: number,
  limit: number,
  out: string[],
  currentDepth = 0,
): void {
  if (out.length >= limit || currentDepth > maxDepth || !fs.existsSync(baseDir))
    return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, maxDepth, limit, out, currentDepth + 1);
      continue;
    }
    out.push(fullPath);
  }
}

function isMemoryCandidateFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'settings.json') return true;
  const ext = path.extname(base);
  return MEMORY_SOURCE_EXTENSIONS.has(ext);
}

function listMemorySources(user: AuthUser): MemorySource[] {
  const files = new Set<string>();
  const isAdmin = user.role === 'admin';
  const groups = getAllRegisteredGroups();
  const accessibleFolders = new Set<string>();

  if (isAdmin) {
    for (const group of Object.values(groups)) {
      accessibleFolders.add(group.folder);
    }
  } else {
    for (const group of Object.values(groups)) {
      if (group.created_by === user.id) {
        accessibleFolders.add(group.folder);
      }
    }
  }

  // 1. User-global memory: each user only sees their own
  files.add(path.join(USER_GLOBAL_DIR, user.id, PRIMARY_MEMORY_FILE));

  // 2. Group memories: filter by ownership
  for (const folder of accessibleFolders) {
    files.add(path.join(GROUPS_DIR, folder, PRIMARY_MEMORY_FILE));
  }

  // 3. Scan group directories (filtered by access)
  for (const folder of accessibleFolders) {
    const folderDir = path.join(GROUPS_DIR, folder);
    const scanned: string[] = [];
    walkFiles(folderDir, 4, MEMORY_LIST_LIMIT, scanned);
    for (const f of scanned) {
      if (isMemoryCandidateFile(f)) files.add(f);
    }
  }

  // 4. Scan data/memory/ (filtered by folder access)
  if (fs.existsSync(MEMORY_DATA_DIR)) {
    const memFolders = fs.readdirSync(MEMORY_DATA_DIR, { withFileTypes: true });
    for (const d of memFolders) {
      if (d.isDirectory() && (isAdmin || accessibleFolders.has(d.name))) {
        const scanned: string[] = [];
        walkFiles(
          path.join(MEMORY_DATA_DIR, d.name),
          4,
          MEMORY_LIST_LIMIT,
          scanned,
        );
        for (const f of scanned) {
          if (isMemoryCandidateFile(f)) files.add(f);
        }
      }
    }
  }

  // 5. Scan sessions (filtered by folder access)
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const sessFolders = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const d of sessFolders) {
      if (d.isDirectory() && (isAdmin || accessibleFolders.has(d.name))) {
        const scanned: string[] = [];
        walkFiles(
          path.join(sessionsDir, d.name),
          7,
          MEMORY_LIST_LIMIT,
          scanned,
        );
        for (const f of scanned) {
          if (isMemoryCandidateFile(f)) files.add(f);
        }
      }
    }
  }

  const sources: MemorySource[] = [];
  for (const absolutePath of files) {
    const readable =
      isWithinRoot(absolutePath, GROUPS_DIR) ||
      isWithinRoot(absolutePath, MEMORY_DATA_DIR) ||
      isWithinRoot(absolutePath, path.join(DATA_DIR, 'sessions'));
    if (!readable) continue;

    const relativePath = path
      .relative(process.cwd(), absolutePath)
      .replace(/\\/g, '/');
    const writable =
      isWithinRoot(absolutePath, GROUPS_DIR) ||
      isWithinRoot(absolutePath, MEMORY_DATA_DIR);
    const exists = fs.existsSync(absolutePath);
    let updatedAt: string | null = null;
    let size = 0;
    if (exists) {
      const stat = fs.statSync(absolutePath);
      updatedAt = stat.mtime.toISOString();
      size = stat.size;
    }

    const classified = classifyMemorySource(relativePath);
    sources.push({
      writable,
      exists,
      updatedAt,
      size,
      ...classified,
    });
  }

  const scopeRank: Record<MemorySource['scope'], number> = {
    'user-global': 0,
    main: 1,
    flow: 2,
    session: 3,
  };
  const kindRank: Record<MemorySource['kind'], number> = {
    primary: 0,
    note: 1,
    session: 2,
  };

  sources.sort((a, b) => {
    if (scopeRank[a.scope] !== scopeRank[b.scope])
      return scopeRank[a.scope] - scopeRank[b.scope];
    if (kindRank[a.kind] !== kindRank[b.kind])
      return kindRank[a.kind] - kindRank[b.kind];
    return a.locator.localeCompare(b.locator, 'zh-CN');
  });

  return sources.slice(0, MEMORY_LIST_LIMIT);
}

function buildSearchSnippet(
  content: string,
  index: number,
  keywordLength: number,
): string {
  const start = Math.max(0, index - 36);
  const end = Math.min(content.length, index + keywordLength + 36);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function searchMemorySources(
  keyword: string,
  user: AuthUser,
  limit = MEMORY_SEARCH_LIMIT,
): MemorySearchHit[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return [];

  const maxResults = Number.isFinite(limit)
    ? Math.max(1, Math.min(MEMORY_SEARCH_LIMIT, Math.trunc(limit)))
    : MEMORY_SEARCH_LIMIT;

  const hits: MemorySearchHit[] = [];
  const sources = listMemorySources(user);

  for (const source of sources) {
    if (hits.length >= maxResults) break;
    if (!source.exists || source.size === 0) continue;
    if (source.size > MAX_MEMORY_FILE_LENGTH) continue;

    try {
      const payload = readMemoryFile(source.locator, user);
      const lower = payload.content.toLowerCase();
      const firstIndex = lower.indexOf(normalizedKeyword);
      if (firstIndex === -1) continue;

      let count = 0;
      let from = 0;
      while (from < lower.length) {
        const idx = lower.indexOf(normalizedKeyword, from);
        if (idx === -1) break;
        count += 1;
        from = idx + normalizedKeyword.length;
      }

      hits.push({
        ...source,
        hits: count,
        snippet: buildSearchSnippet(
          payload.content,
          firstIndex,
          normalizedKeyword.length,
        ),
      });
    } catch {
      continue;
    }
  }

  return hits;
}

// --- Routes ---
// All memory routes require authentication (member + admin).
// User-level filtering is handled inside each function.

memoryRoutes.get('/sources', authMiddleware, (c) => {
  try {
    const user = c.get('user') as AuthUser;
    return c.json({ sources: listMemorySources(user) });
  } catch (err) {
    logger.error({ err }, 'Failed to list memory sources');
    return c.json({ error: 'Failed to list memory sources' }, 500);
  }
});

memoryRoutes.get('/search', authMiddleware, (c) => {
  const query = c.req.query('q');
  if (!query || !query.trim()) {
    return c.json({ error: 'Missing q' }, 400);
  }
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) ? limitRaw : MEMORY_SEARCH_LIMIT;
  try {
    const user = c.get('user') as AuthUser;
    return c.json({ hits: searchMemorySources(query, user, limit) });
  } catch (err) {
    logger.error({ err }, 'Failed to search memory sources');
    return c.json({ error: 'Failed to search memory sources' }, 500);
  }
});

memoryRoutes.get('/file', authMiddleware, (c) => {
  const requested = c.req.query('locator') ?? c.req.query('path');
  if (!requested) return c.json({ error: 'Missing locator' }, 400);
  try {
    const user = c.get('user') as AuthUser;
    return c.json(readMemoryFile(requested, user));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to read memory file';
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

memoryRoutes.put('/file', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryFileSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      writeMemoryFile(
        validation.data.locator ?? validation.data.path ?? '',
        validation.data.content,
        user,
      ),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write memory file';
    return c.json({ error: message }, 400);
  }
});

export default memoryRoutes;

// Skills management routes

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Variables } from '../../../app/web/context.js';
import type { AuthUser } from '../../../shared/types.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { DATA_DIR } from '../../../app/config.js';
import {
  getSystemSettings,
  saveSystemSettings,
  type SystemSettings,
} from '../../../runtime-config.js';
import { installSkillPackageToDirectory } from '../skill-installer.js';
import {
  parseFrontmatter,
  validateSkillId,
  validateSkillPath,
  listFiles,
  scanSkillDirectory,
} from '../skill-utils.js';
let skillInstallLock: Promise<void> = Promise.resolve();

const skillsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project';
  enabled: boolean;
  syncedFromHost?: boolean;
  packageName?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface SkillDetail extends Skill {
  content: string;
}

interface HostSyncManifest {
  syncedSkills: string[];
  lastSyncAt: string;
}

interface SkillsManifest {
  skills: Record<
    string,
    {
      packageName: string;
      installedAt: string;
      source: string;
    }
  >;
}

interface SearchResult {
  package: string;
  url: string;
  description?: string;
  installs?: number;
  skillId?: string;
  source?: string;
}

// --- Utility Functions ---

function getUserSkillsDir(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId);
}

function getGlobalSkillsDir(): string {
  return path.join(os.homedir(), '.codex', 'skills');
}

function getProjectSkillsDir(): string {
  return path.resolve(process.cwd(), 'container', 'skills');
}

function copySkillToUser(src: string, dest: string): void {
  let realSrc = src;
  try {
    const lstat = fs.lstatSync(src);
    if (lstat.isSymbolicLink()) {
      realSrc = fs.realpathSync(src);
    }
  } catch {
    // keep original path if inspection fails
  }

  fs.cpSync(realSrc, dest, { recursive: true });
}

function getHostSyncManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.host-sync.json');
}

function readHostSyncManifest(userId: string): HostSyncManifest {
  try {
    const data = fs.readFileSync(getHostSyncManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { syncedSkills: [], lastSyncAt: '' };
  }
}

function writeHostSyncManifest(
  userId: string,
  manifest: HostSyncManifest,
): void {
  const manifestPath = getHostSyncManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function getSkillsManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.skills-manifest.json');
}

function readSkillsManifest(userId: string): SkillsManifest {
  try {
    const data = fs.readFileSync(getSkillsManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { skills: {} };
  }
}

function writeSkillsManifest(userId: string, manifest: SkillsManifest): void {
  const manifestPath = getSkillsManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Update the skills manifest after installing skills.
 * Records packageName, installedAt, and source for each installed skill.
 */
function updateSkillsManifest(
  userId: string,
  packageName: string,
  installedSkillIds: string[],
): void {
  const manifest = readSkillsManifest(userId);
  const now = new Date().toISOString();
  for (const id of installedSkillIds) {
    manifest.skills[id] = {
      packageName,
      installedAt: now,
      source: 'skills.sh',
    };
  }
  writeSkillsManifest(userId, manifest);
}

/**
 * Remove a skill from the manifest when it is deleted.
 */
function removeFromSkillsManifest(userId: string, skillId: string): void {
  const manifest = readSkillsManifest(userId);
  if (skillId in manifest.skills) {
    delete manifest.skills[skillId];
    writeSkillsManifest(userId, manifest);
  }
}

// validateSkillId, validateSkillPath, parseFrontmatter, listFiles, scanSkillDirectory
// are imported from '../skill-utils.js'

function scanDirectory(rootDir: string, source: 'user' | 'project'): Skill[] {
  return scanSkillDirectory(rootDir, source) as Skill[];
}

function discoverSkills(userId: string): Skill[] {
  const userSkills = scanDirectory(getUserSkillsDir(userId), 'user');
  const projectSkills = scanDirectory(getProjectSkillsDir(), 'project');

  // 读取 host sync manifest 标记同步来源
  const hostManifest = readHostSyncManifest(userId);
  const syncedSet = new Set(hostManifest.syncedSkills);

  // 读取 skills manifest 补充安装元数据
  const skillsManifest = readSkillsManifest(userId);

  for (const skill of userSkills) {
    if (syncedSet.has(skill.id)) {
      skill.syncedFromHost = true;
    }
    const meta = skillsManifest.skills[skill.id];
    if (meta) {
      skill.packageName = meta.packageName;
      skill.installedAt = meta.installedAt;
    }
  }

  return [...userSkills, ...projectSkills];
}

function getSkillDetail(skillId: string, userId: string): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  const searchDirs: Array<{ rootDir: string; source: 'user' | 'project' }> = [
    { rootDir: getUserSkillsDir(userId), source: 'user' },
    { rootDir: getProjectSkillsDir(), source: 'project' },
  ];

  const hostManifest = readHostSyncManifest(userId);
  const syncedSet = new Set(hostManifest.syncedSkills);
  const skillsManifest = readSkillsManifest(userId);

  for (const { rootDir, source } of searchDirs) {
    const skillDir = path.join(rootDir, skillId);
    if (!fs.existsSync(skillDir)) continue;

    if (!validateSkillPath(rootDir, skillDir)) continue;

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const skillMdDisabledPath = path.join(skillDir, 'SKILL.md.disabled');

    let enabled = false;
    let skillFilePath: string | null = null;

    if (fs.existsSync(skillMdPath)) {
      enabled = true;
      skillFilePath = skillMdPath;
    } else if (fs.existsSync(skillMdDisabledPath)) {
      enabled = false;
      skillFilePath = skillMdDisabledPath;
    } else {
      continue;
    }

    try {
      const content = fs.readFileSync(skillFilePath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const stats = fs.statSync(skillDir);

      const detail: SkillDetail = {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || '',
        source,
        enabled,
        userInvocable:
          frontmatter['user-invocable'] === undefined
            ? true
            : frontmatter['user-invocable'] !== 'false',
        allowedTools: frontmatter['allowed-tools']
          ? frontmatter['allowed-tools'].split(',').map((t) => t.trim())
          : [],
        argumentHint: frontmatter['argument-hint'] || null,
        updatedAt: stats.mtime.toISOString(),
        files: listFiles(skillDir),
        content,
      };

      if (source === 'user') {
        if (syncedSet.has(skillId)) {
          detail.syncedFromHost = true;
        }
        const meta = skillsManifest.skills[skillId];
        if (meta) {
          detail.packageName = meta.packageName;
          detail.installedAt = meta.installedAt;
        }
      }

      return detail;
    } catch {
      // Skip malformed skill
    }
  }

  return null;
}

// --- Search cache (LRU, 5min TTL, max 100 entries) ---

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map<string, CacheEntry<SearchResult[]>>();

function getCachedSearch(key: string): SearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedSearch(key: string, value: SearchResult[]): void {
  // Evict oldest if at capacity
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL });
}

/**
 * Search skills via skills.sh API.
 * Returns structured results with install counts.
 */
async function searchSkillsApi(query: string): Promise<SearchResult[]> {
  const cached = getCachedSearch(query);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) throw new Error(`skills.sh returned ${resp.status}`);

    const data = (await resp.json()) as {
      skills?: Array<{
        id: string;
        skillId: string;
        name: string;
        installs: number;
        source: string;
      }>;
    };

    const results: SearchResult[] = (data.skills || []).map((s) => ({
      package:
        s.source === s.skillId || !s.skillId
          ? s.source
          : `${s.source}@${s.skillId}`,
      url: `https://skills.sh/s/${s.id}`,
      description: '',
      installs: s.installs,
      skillId: s.skillId,
      source: s.source,
    }));

    setCachedSearch(query, results);
    return results;
  } catch {
    return [];
  }
}

/**
 * Fetch SKILL.md content from GitHub for a given source repo and skill ID.
 * Tries multiple common directory layouts.
 */
async function fetchSkillMdFromGitHub(
  source: string,
  skillId: string,
): Promise<{ content: string; description: string; skillName: string } | null> {
  // Try common paths where SKILL.md might live
  const pathCandidates = [
    `skills/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
    `.codex/skills/${skillId}/SKILL.md`,
    `SKILL.md`,
  ];

  for (const branch of ['main', 'master']) {
    for (const filePath of pathCandidates) {
      try {
        const url = `https://raw.githubusercontent.com/${source}/${branch}/${filePath}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!resp.ok) continue;

        const content = await resp.text();
        // Verify it looks like a SKILL.md (has frontmatter)
        if (!content.startsWith('---')) continue;

        const frontmatter = parseFrontmatter(content);
        return {
          content,
          description: frontmatter.description || '',
          skillName: frontmatter.name || skillId,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function withSkillInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = skillInstallLock.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  skillInstallLock = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// --- Routes ---

skillsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const skills = discoverSkills(authUser.id);
  return c.json({ skills });
});

skillsRoutes.get('/search', authMiddleware, async (c) => {
  const query = c.req.query('q')?.trim();
  if (!query) {
    return c.json({ results: [] });
  }

  const results = await searchSkillsApi(query);
  return c.json({ results });
});

skillsRoutes.get('/search/detail', authMiddleware, async (c) => {
  const source = c.req.query('source')?.trim();
  const skillId = c.req.query('skillId')?.trim();

  if (!source || !skillId) {
    return c.json({ detail: null });
  }

  const result = await fetchSkillMdFromGitHub(source, skillId);
  if (!result) {
    return c.json({ detail: null });
  }

  return c.json({
    detail: {
      description: result.description,
      skillName: result.skillName,
      readme: result.content,
      installs: '',
      age: '',
      features: [],
    },
  });
});

// Get sync status (last sync time + auto-sync config)
skillsRoutes.get('/sync-status', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const manifest = readHostSyncManifest(authUser.id);
  const settings = getSystemSettings();
  return c.json({
    lastSyncAt: manifest.lastSyncAt || null,
    syncedCount: manifest.syncedSkills.length,
    autoSyncEnabled: settings.skillAutoSyncEnabled,
    autoSyncIntervalMinutes: settings.skillAutoSyncIntervalMinutes,
  });
});

// Toggle auto-sync on/off (admin only)
skillsRoutes.put('/sync-settings', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can change sync settings' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const updates: Partial<SystemSettings> = {};
  if (typeof body.autoSyncEnabled === 'boolean') {
    updates.skillAutoSyncEnabled = body.autoSyncEnabled;
  }
  if (
    typeof body.autoSyncIntervalMinutes === 'number' &&
    body.autoSyncIntervalMinutes >= 1
  ) {
    updates.skillAutoSyncIntervalMinutes = body.autoSyncIntervalMinutes;
  }
  const saved = saveSystemSettings(updates);
  return c.json({
    autoSyncEnabled: saved.skillAutoSyncEnabled,
    autoSyncIntervalMinutes: saved.skillAutoSyncIntervalMinutes,
  });
});

skillsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const skill = getSkillDetail(id, authUser.id);

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

// Toggle enable/disable for user-level skills via SKILL.md ↔ SKILL.md.disabled rename.
// Project-level skills are read-only.
skillsRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const { enabled } = await c.req.json<{ enabled: boolean }>();

  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);

  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);

  if (!fs.existsSync(skillDir)) {
    return c.json(
      { error: 'Skill not found or is not a user-level skill' },
      404,
    );
  }
  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  const srcPath = path.join(
    skillDir,
    enabled ? 'SKILL.md.disabled' : 'SKILL.md',
  );
  const dstPath = path.join(
    skillDir,
    enabled ? 'SKILL.md' : 'SKILL.md.disabled',
  );

  if (!fs.existsSync(srcPath)) {
    return c.json(
      { error: 'Skill not found or already in desired state' },
      404,
    );
  }

  fs.renameSync(srcPath, dstPath);
  return c.json({ success: true });
});

/**
 * Delete a user-level skill by ID.
 * Reusable by both the HTTP route and IPC handler.
 */
function deleteSkillForUser(
  userId: string,
  skillId: string,
): { success: boolean; error?: string } {
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  const userDir = getUserSkillsDir(userId);
  const skillDir = path.join(userDir, skillId);

  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'Skill not found or is a project-level skill',
    };
  }

  if (!validateSkillPath(userDir, skillDir)) {
    return { success: false, error: 'Invalid skill path' };
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removeFromSkillsManifest(userId, skillId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

skillsRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const result = deleteSkillForUser(authUser.id, id);

  if (!result.success) {
    const status =
      result.error === 'Invalid skill ID' ||
      result.error === 'Invalid skill path'
        ? 400
        : result.error?.includes('not found')
          ? 404
          : 500;
    return c.json({ error: result.error }, status);
  }

  return c.json({ success: true });
});

/**
 * Install a skill package for a specific user.
 * Reusable by both the HTTP route and IPC handler.
 */
async function installSkillForUser(
  userId: string,
  pkg: string,
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  try {
    const userDir = getUserSkillsDir(userId);
    const installedEntries = await installSkillPackageToDirectory(pkg, userDir);

    // Write manifest metadata
    updateSkillsManifest(userId, pkg, installedEntries);

    return { success: true, installed: installedEntries };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Sync host-level skills (~/.codex/skills/) to a user's directory.
 * Standalone function usable from both the API route and the auto-sync timer.
 */
async function syncHostSkillsForUser(userId: string): Promise<{
  stats: { added: number; updated: number; deleted: number; skipped: number };
  total: number;
}> {
  return withSkillInstallLock(async () => {
    const hostDir = getGlobalSkillsDir();
    const userDir = getUserSkillsDir(userId);
    fs.mkdirSync(userDir, { recursive: true });

    // 1. 扫描宿主机 skills
    const hostSkillNames: string[] = [];
    if (fs.existsSync(hostDir)) {
      for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillDir = path.join(hostDir, entry.name);
        try {
          const realPath = fs.realpathSync(skillDir);
          if (
            fs.existsSync(path.join(realPath, 'SKILL.md')) ||
            fs.existsSync(path.join(realPath, 'SKILL.md.disabled'))
          ) {
            hostSkillNames.push(entry.name);
          }
        } catch {
          // 跳过 broken symlinks
        }
      }
    }

    // 2. 读取 manifest
    const manifest = readHostSyncManifest(userId);
    const previouslySynced = new Set(manifest.syncedSkills);

    // 3. 检测用户目录中手动安装的 skills
    const existingUserSkills = new Set<string>();
    if (fs.existsSync(userDir)) {
      for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
        if (entry.isDirectory()) existingUserSkills.add(entry.name);
      }
    }

    const stats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
    const newSyncedList: string[] = [];

    // 4. 同步：新增/更新
    for (const name of hostSkillNames) {
      const isManuallyInstalled =
        existingUserSkills.has(name) && !previouslySynced.has(name);
      if (isManuallyInstalled) {
        stats.skipped++;
        continue;
      }

      const src = path.join(hostDir, name);
      const dest = path.join(userDir, name);

      if (existingUserSkills.has(name)) {
        fs.rmSync(dest, { recursive: true, force: true });
        copySkillToUser(src, dest);
        stats.updated++;
      } else {
        copySkillToUser(src, dest);
        stats.added++;
      }
      newSyncedList.push(name);
    }

    // 5. 删除宿主机已移除的（仅清理之前同步来的）
    const hostSkillSet = new Set(hostSkillNames);
    for (const name of previouslySynced) {
      if (!hostSkillSet.has(name) && existingUserSkills.has(name)) {
        const dest = path.join(userDir, name);
        fs.rmSync(dest, { recursive: true, force: true });
        stats.deleted++;
      }
    }

    // 6. 更新 manifest
    writeHostSyncManifest(userId, {
      syncedSkills: newSyncedList,
      lastSyncAt: new Date().toISOString(),
    });

    return { stats, total: hostSkillNames.length };
  });
}

// Sync host-level skills — API endpoint (admin only).
skillsRoutes.post('/sync-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host skills' }, 403);
  }

  const result = await syncHostSkillsForUser(authUser.id);
  return c.json(result);
});

skillsRoutes.post('/install', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  if (typeof body.package !== 'string') {
    return c.json({ error: 'package field must be string' }, 400);
  }

  const pkg = body.package.trim();
  const result = await installSkillForUser(authUser.id, pkg);

  if (!result.success) {
    return c.json(
      { error: 'Failed to install skill', details: result.error },
      result.error === 'Invalid package name format' ? 400 : 500,
    );
  }

  return c.json({ success: true, installed: result.installed });
});

// Reinstall a skill by its ID — requires the skill to have a packageName in the manifest.
skillsRoutes.post('/:id/reinstall', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const manifest = readSkillsManifest(authUser.id);
  const meta = manifest.skills[id];
  if (!meta?.packageName) {
    return c.json(
      { error: 'Skill has no package info — cannot reinstall' },
      400,
    );
  }

  // Delete then reinstall
  const deleteResult = deleteSkillForUser(authUser.id, id);
  if (!deleteResult.success) {
    return c.json(
      { error: 'Failed to delete old skill', details: deleteResult.error },
      500,
    );
  }

  const installResult = await installSkillForUser(
    authUser.id,
    meta.packageName,
  );
  if (!installResult.success) {
    return c.json(
      { error: 'Failed to reinstall skill', details: installResult.error },
      500,
    );
  }

  return c.json({ success: true, installed: installResult.installed });
});

export {
  getUserSkillsDir,
  installSkillForUser,
  deleteSkillForUser,
  syncHostSkillsForUser,
};
export default skillsRoutes;

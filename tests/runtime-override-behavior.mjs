#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const schemasPath = path.join(repoRoot, 'src', 'schemas.ts');
  const groupsRoutePath = path.join(
    repoRoot,
    'src',
    'features',
    'groups',
    'routes',
    'groups.ts',
  );
  const groupHelpersPath = path.join(repoRoot, 'src', 'db', 'group-helpers.ts');
  const taskSessionsPath = path.join(
    repoRoot,
    'src',
    'db',
    'tasks-sessions.ts',
  );
  const containerRunnerPath = path.join(
    repoRoot,
    'src',
    'features',
    'execution',
    'container-runner.ts',
  );
  const runtimeAdapterPath = path.join(
    repoRoot,
    'src',
    'features',
    'chat-runtime',
    'agent-runtime-adapter.ts',
  );
  const createDialogPath = path.join(
    repoRoot,
    'web',
    'src',
    'components',
    'chat',
    'CreateContainerDialog.tsx',
  );
  const createFlowOptionsPath = path.join(
    repoRoot,
    'web',
    'src',
    'components',
    'chat',
    'create-flow-options.ts',
  );
  const groupActionsPath = path.join(
    repoRoot,
    'web',
    'src',
    'stores',
    'chat',
    'actions',
    'group-actions.ts',
  );
  const groupDetailPath = path.join(
    repoRoot,
    'web',
    'src',
    'components',
    'groups',
    'GroupDetail.tsx',
  );
  const sqliteCompatPath = path.join(repoRoot, 'dist', 'sqlite-compat.js');
  const dbModulePath = path.join(repoRoot, 'dist', 'db.js');

  const [
    schemasSource,
    groupsRouteSource,
    groupHelpersSource,
    taskSessionsSource,
    containerRunnerSource,
    runtimeAdapterSource,
    createDialogSource,
    createFlowOptionsSource,
    groupActionsSource,
    groupDetailSource,
  ] = await Promise.all([
    readFile(schemasPath, 'utf8'),
    readFile(groupsRoutePath, 'utf8'),
    readFile(groupHelpersPath, 'utf8'),
    readFile(taskSessionsPath, 'utf8'),
    readFile(containerRunnerPath, 'utf8'),
    readFile(runtimeAdapterPath, 'utf8'),
    readFile(createDialogPath, 'utf8'),
    readFile(createFlowOptionsPath, 'utf8'),
    readFile(groupActionsPath, 'utf8'),
    readFile(groupDetailPath, 'utf8'),
  ]);

  const groupPatchSchemaSource = schemasSource.match(
    /export const GroupPatchSchema = z\.object\(\{[\s\S]*?\n\}\);/,
  )?.[0];
  assert.ok(groupPatchSchemaSource, 'GroupPatchSchema definition exists');
  assert.doesNotMatch(
    groupPatchSchemaSource,
    /\bruntime\s*:/,
    'GroupPatchSchema no longer accepts runtime override fields',
  );
  assert.doesNotMatch(
    groupsRouteSource,
    /hasRuntimeField|validation\.data,\s*'runtime'|existing\.runtime|runtime\s*\?\?\s*undefined/,
    'groups route no longer handles runtime override updates',
  );
  assert.doesNotMatch(
    createDialogSource,
    /runtimeSelection|RuntimeOverrideSelection|继承系统默认|runtime\b/,
    'create dialog no longer exposes runtime override state or controls',
  );
  assert.doesNotMatch(
    createFlowOptionsSource,
    /\bruntime\b/,
    'workspace creation flow options no longer submit runtime overrides',
  );
  assert.doesNotMatch(
    groupActionsSource,
    /\bruntime\b/,
    'chat store group actions no longer send runtime override payloads',
  );
  assert.match(
    groupDetailSource,
    /Codex（固定）/,
    'group detail shows the runtime as fixed Codex-only information',
  );
  assert.doesNotMatch(
    groupHelpersSource,
    /parseRuntimeType|Invalid runtime|falling back to system default/,
    'DB group parsing no longer revives or logs legacy runtime values',
  );
  assert.doesNotMatch(
    taskSessionsSource,
    /SELECT session_id,\s*runtime|parseRuntimeType|excluded\.runtime/,
    'runtime session persistence no longer reads or preserves runtime metadata',
  );
  assert.match(
    containerRunnerSource,
    /return getSystemSettings\(\)\.defaultRuntime;/,
    'container runtime resolution uses only the Codex default runtime',
  );
  assert.match(
    runtimeAdapterSource,
    /return deps\.getSystemSettings\(\)\.defaultRuntime;/,
    'host/runtime adapter resolution uses only the Codex default runtime',
  );

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happypaw-runtime-metadata-'),
  );
  process.chdir(tempRoot);

  const { default: Database } = await import(sqliteCompatPath);
  const dbPath = path.join(tempRoot, 'data', 'db', 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const seedDb = new Database(dbPath);
  seedDb.exec(`
    CREATE TABLE router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE sessions (
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      runtime TEXT,
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      execution_mode TEXT,
      runtime TEXT,
      custom_cwd TEXT,
      init_source_path TEXT,
      init_git_url TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0,
      selected_skills TEXT,
      target_agent_id TEXT,
      target_main_jid TEXT,
      reply_policy TEXT,
      require_mention INTEGER,
      activation_mode TEXT,
      mcp_mode TEXT,
      selected_mcps TEXT
    );
  `);
  seedDb
    .prepare('INSERT INTO router_state (key, value) VALUES (?, ?)')
    .run('schema_version', '33');
  seedDb
    .prepare(
      `INSERT INTO registered_groups (
        jid, name, folder, added_at, execution_mode, runtime, created_by, is_home
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'web:legacy',
      'Legacy Workspace',
      'legacy-folder',
      '2026-03-28T00:00:00.000Z',
      'container',
      'legacy_runtime',
      'u1',
      0,
    );
  seedDb
    .prepare(
      'INSERT INTO sessions (group_folder, session_id, agent_id, runtime) VALUES (?, ?, ?, ?)',
    )
    .run('legacy-folder', 'legacy-thread', '', 'legacy_runtime');
  seedDb.close();

  const { initDatabase, closeDatabase, getRegisteredGroup, getRuntimeSession } =
    await import(dbModulePath);

  initDatabase();

  const migratedDb = new Database(dbPath);
  const migratedGroup = migratedDb
    .prepare('SELECT runtime FROM registered_groups WHERE jid = ?')
    .get('web:legacy');
  const migratedSession = migratedDb
    .prepare(
      'SELECT runtime FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get('legacy-folder', '');
  assert.equal(
    migratedGroup?.runtime ?? null,
    null,
    'schema migration clears persisted group runtime metadata',
  );
  assert.equal(
    migratedSession?.runtime ?? null,
    null,
    'schema migration clears persisted session runtime metadata',
  );
  assert.equal(
    getRegisteredGroup('web:legacy')?.runtime,
    undefined,
    'registered group loading ignores legacy runtime metadata',
  );
  assert.deepEqual(
    getRuntimeSession('legacy-folder'),
    { sessionId: 'legacy-thread' },
    'session loading preserves Codex thread identity without runtime metadata',
  );
  migratedDb.close();
  closeDatabase();

  console.log('✅ runtime metadata cleanup checks passed');
}

main().catch((error) => {
  console.error('❌ runtime metadata cleanup checks failed');
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-main-restart-recovery-'),
);

process.chdir(tempRoot);

const { initDatabase, closeDatabase, setSession, getRuntimeSession } =
  await import(path.join(repoRoot, 'dist', 'db.js'));
const { clearPersistedRuntimeStateForRecovery } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'chat-runtime',
    'runtime-state-cleanup.js',
  ),
);
const { resolveRuntimeScopePaths } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'execution',
    'container-runner.js',
  ),
);

initDatabase();

const sessions = /** @type {Record<string, {sessionId: string}>} */ ({
  'workspace-main': {
    sessionId: 'main-thread',
  },
});

const mainScope = resolveRuntimeScopePaths('workspace-main');
const secondaryScope = resolveRuntimeScopePaths('workspace-main', {
  conversationId: 'telegram:workspace-main',
});

fs.mkdirSync(mainScope.codexHomeDir, { recursive: true });
fs.mkdirSync(secondaryScope.codexHomeDir, { recursive: true });
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'config.toml'), 'model=1');
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'thread.json'), 'main-thread');
fs.writeFileSync(
  path.join(secondaryScope.codexHomeDir, 'config.toml'),
  'model=1',
);
fs.writeFileSync(
  path.join(secondaryScope.codexHomeDir, 'thread.json'),
  'secondary-thread',
);

setSession('workspace-main', 'main-thread');
setSession('workspace-main', 'secondary-thread', {
  conversationId: 'telegram:workspace-main',
});

clearPersistedRuntimeStateForRecovery(sessions, 'workspace-main');

assert.equal(
  getRuntimeSession('workspace-main'),
  undefined,
  'startup recovery should clear the stale main-session mapping',
);
assert.deepEqual(
  getRuntimeSession('workspace-main', {
    conversationId: 'telegram:workspace-main',
  }),
  {
    sessionId: 'secondary-thread',
  },
  'startup recovery must preserve unrelated secondary mappings',
);
assert.equal(
  sessions['workspace-main'],
  undefined,
  'in-memory main-session cache should be cleared during startup recovery',
);
assert.ok(
  fs.existsSync(path.join(mainScope.codexHomeDir, 'config.toml')),
  'main runtime config scaffold should be preserved',
);
assert.ok(
  !fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')),
  'startup recovery should clear stale main-session runtime files',
);
assert.ok(
  fs.existsSync(path.join(secondaryScope.codexHomeDir, 'thread.json')),
  'startup recovery must preserve sibling secondary runtime files',
);

console.log('✅ main-session restart recovery preserves secondary checks passed');
closeDatabase();

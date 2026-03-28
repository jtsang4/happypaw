#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-restart-agent-recovery-')
);

process.chdir(tempRoot);

const { initDatabase, closeDatabase, setSession, getRuntimeSession } = await import(
  path.join(repoRoot, 'dist', 'db.js')
);
const {
  clearPersistedRuntimeStateForRecovery,
} = await import(path.join(repoRoot, 'dist', 'runtime-state-cleanup.js'));
const { resolveRuntimeScopePaths } = await import(
  path.join(repoRoot, 'dist', 'container-runner.js')
);

initDatabase();

const sessions = /** @type {Record<string, {sessionId: string}>} */ ({
  'workspace-main': {
    sessionId: 'main-thread',
  },
});

const agentScope = resolveRuntimeScopePaths('workspace-main', {
  agentId: 'agent-42',
});

fs.mkdirSync(agentScope.codexHomeDir, { recursive: true });
fs.writeFileSync(path.join(agentScope.codexHomeDir, 'config.toml'), 'model=1');
fs.writeFileSync(
  path.join(agentScope.codexHomeDir, 'thread.json'),
  'stale-agent-thread'
);

setSession('workspace-main', 'main-thread');
setSession('workspace-main', 'agent-thread-before-restart', 'agent-42');

clearPersistedRuntimeStateForRecovery(sessions, 'workspace-main', 'agent-42');

assert.deepEqual(sessions, {
  'workspace-main': {
    sessionId: 'main-thread',
  },
});
assert.deepEqual(getRuntimeSession('workspace-main'), {
  sessionId: 'main-thread',
});
assert.equal(getRuntimeSession('workspace-main', 'agent-42'), undefined);
assert.ok(fs.existsSync(path.join(agentScope.codexHomeDir, 'config.toml')));
assert.ok(!fs.existsSync(path.join(agentScope.codexHomeDir, 'thread.json')));

console.log('✅ restart agent session recovery cleanup checks passed');
closeDatabase();

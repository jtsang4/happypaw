#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-workspace-reset-runtime-')
);

process.chdir(tempRoot);

const { clearWorkspaceRuntimeState } = await import(
  path.join(repoRoot, 'dist', 'runtime-state-cleanup.js')
);
const { resolveRuntimeScopePaths } = await import(
  path.join(repoRoot, 'dist', 'container-runner.js')
);
const { initDatabase, closeDatabase, setSession, getRuntimeSession } = await import(
  path.join(repoRoot, 'dist', 'db.js')
);

initDatabase();

const groupDir = path.join(tempRoot, 'data', 'groups', 'workspace-a');
const memoryDir = path.join(tempRoot, 'data', 'memory', 'workspace-a');
const ipcDir = path.join(tempRoot, 'data', 'ipc', 'workspace-a');
const envDir = path.join(tempRoot, 'data', 'env', 'workspace-a');
const mainScope = resolveRuntimeScopePaths('workspace-a');
const agentScope = resolveRuntimeScopePaths('workspace-a', {
  agentId: 'agent-1',
});

for (const dir of [
  groupDir,
  memoryDir,
  ipcDir,
  envDir,
  mainScope.codexHomeDir,
  agentScope.codexHomeDir,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(path.join(groupDir, 'AGENTS.md'), 'workspace memory');
fs.writeFileSync(path.join(memoryDir, '2026-03-26.md'), 'memory');
fs.writeFileSync(path.join(ipcDir, 'stale.json'), '{}');
fs.writeFileSync(path.join(envDir, 'env'), 'KEY=value');
fs.writeFileSync(
  path.join(mainScope.codexHomeDir, 'config.toml'),
  'model = "gpt-5"'
);
fs.writeFileSync(
  path.join(mainScope.codexHomeDir, 'thread.json'),
  'main-thread'
);
fs.writeFileSync(
  path.join(agentScope.codexHomeDir, 'config.toml'),
  'model = "gpt-5"'
);
fs.writeFileSync(
  path.join(agentScope.codexHomeDir, 'thread.json'),
  'agent-thread'
);

setSession('workspace-a', 'main-thread');
setSession('workspace-a', 'agent-thread', 'agent-1');

clearWorkspaceRuntimeState('workspace-a');

assert.ok(fs.existsSync(groupDir));
assert.deepEqual(fs.readdirSync(groupDir), []);
assert.ok(fs.existsSync(path.join(ipcDir, 'input')));
assert.ok(fs.existsSync(path.join(ipcDir, 'messages')));
assert.ok(fs.existsSync(path.join(ipcDir, 'tasks')));
assert.ok(!fs.existsSync(memoryDir));
assert.ok(fs.existsSync(envDir));
assert.ok(fs.existsSync(path.join(envDir, 'env')));
assert.ok(!fs.existsSync(mainScope.codexHomeDir));
assert.ok(!fs.existsSync(agentScope.codexHomeDir));
assert.equal(getRuntimeSession('workspace-a'), undefined);
assert.equal(getRuntimeSession('workspace-a', 'agent-1'), undefined);

console.log('✅ workspace reset runtime cleanup checks passed');
closeDatabase();

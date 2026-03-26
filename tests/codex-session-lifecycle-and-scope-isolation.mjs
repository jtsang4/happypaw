#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-codex-session-scope-')
);
const realTempRoot = fs.realpathSync(tempRoot);

process.chdir(realTempRoot);

const dataDir = path.join(realTempRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const { resolveRuntimeScopePaths } = await import(
  path.join(repoRoot, 'dist', 'container-runner.js')
);
const { ensureAgentDirectories } = await import(
  path.join(repoRoot, 'dist', 'utils.js')
);
const { initDatabase, setSession, getRuntimeSession, deleteSession } =
  await import(path.join(repoRoot, 'dist', 'db.js'));

initDatabase();

const mainScope = resolveRuntimeScopePaths('workspace-a');
const agentScope = resolveRuntimeScopePaths('workspace-a', {
  agentId: 'agent-1',
});
const isolatedTaskScope = resolveRuntimeScopePaths('workspace-a', {
  taskRunId: 'task-1',
});
const isolatedTaskScopeSecondRun = resolveRuntimeScopePaths('workspace-a', {
  taskRunId: 'task-2',
});

assert.equal(mainScope.ipcDir, path.join(dataDir, 'ipc', 'workspace-a'));
assert.equal(
  mainScope.codexHomeDir,
  path.join(dataDir, 'sessions', 'workspace-a', '.codex')
);

assert.equal(
  agentScope.ipcDir,
  path.join(dataDir, 'ipc', 'workspace-a', 'agents', 'agent-1')
);
assert.equal(
  agentScope.codexHomeDir,
  path.join(dataDir, 'sessions', 'workspace-a', 'agents', 'agent-1', '.codex')
);

assert.equal(
  isolatedTaskScope.ipcDir,
  path.join(dataDir, 'ipc', 'workspace-a', 'tasks-run', 'task-1')
);
assert.equal(
  isolatedTaskScope.codexHomeDir,
  path.join(dataDir, 'sessions', 'workspace-a', 'tasks-run', 'task-1', '.codex')
);
assert.equal(
  isolatedTaskScopeSecondRun.codexHomeDir,
  path.join(dataDir, 'sessions', 'workspace-a', 'tasks-run', 'task-2', '.codex')
);

assert.notEqual(mainScope.ipcDir, agentScope.ipcDir);
assert.notEqual(mainScope.ipcDir, isolatedTaskScope.ipcDir);
assert.notEqual(agentScope.ipcDir, isolatedTaskScope.ipcDir);
assert.notEqual(isolatedTaskScope.ipcDir, isolatedTaskScopeSecondRun.ipcDir);
assert.notEqual(mainScope.codexHomeDir, agentScope.codexHomeDir);
assert.notEqual(mainScope.codexHomeDir, isolatedTaskScope.codexHomeDir);
assert.notEqual(agentScope.codexHomeDir, isolatedTaskScope.codexHomeDir);
assert.notEqual(
  isolatedTaskScope.codexHomeDir,
  isolatedTaskScopeSecondRun.codexHomeDir
);

fs.mkdirSync(isolatedTaskScope.codexHomeDir, { recursive: true });
fs.mkdirSync(isolatedTaskScopeSecondRun.codexHomeDir, { recursive: true });
assert.ok(fs.existsSync(isolatedTaskScope.codexHomeDir));
assert.ok(fs.existsSync(isolatedTaskScopeSecondRun.codexHomeDir));

const agentIpcDir = ensureAgentDirectories('workspace-a', 'agent-1');
assert.equal(agentIpcDir, agentScope.ipcDir);
assert.ok(fs.existsSync(path.join(agentIpcDir, 'input')));
assert.ok(fs.existsSync(path.join(agentIpcDir, 'messages')));
assert.ok(fs.existsSync(path.join(agentIpcDir, 'tasks')));
assert.ok(fs.existsSync(path.join(agentIpcDir, 'agents')));
assert.ok(fs.existsSync(agentScope.codexHomeDir));

setSession('workspace-a', 'main-thread', undefined, 'codex_app_server');
setSession('workspace-a', 'agent-thread', 'agent-1', 'codex_app_server');

assert.deepEqual(getRuntimeSession('workspace-a'), {
  sessionId: 'main-thread',
  runtime: 'codex_app_server',
});
assert.deepEqual(getRuntimeSession('workspace-a', 'agent-1'), {
  sessionId: 'agent-thread',
  runtime: 'codex_app_server',
});

deleteSession('workspace-a');
assert.equal(getRuntimeSession('workspace-a'), undefined);
assert.deepEqual(getRuntimeSession('workspace-a', 'agent-1'), {
  sessionId: 'agent-thread',
  runtime: 'codex_app_server',
});

deleteSession('workspace-a', 'agent-1');
assert.equal(getRuntimeSession('workspace-a', 'agent-1'), undefined);

console.log('✅ codex session lifecycle and scope isolation checks passed');

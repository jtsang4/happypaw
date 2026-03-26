#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-session-reset-'),
);

process.chdir(tempRoot);

const { executeSessionReset } = await import(
  path.join(repoRoot, 'dist', 'commands.js')
);
const { resolveRuntimeScopePaths } = await import(
  path.join(repoRoot, 'dist', 'container-runner.js')
);
const {
  initDatabase,
  setRegisteredGroup,
  setSession,
  getRuntimeSession,
} = await import(path.join(repoRoot, 'dist', 'db.js'));

initDatabase();

setRegisteredGroup('web:workspace-a', {
  name: 'Workspace A',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  executionMode: 'container',
});
setRegisteredGroup('telegram:workspace-a', {
  name: 'Workspace A Telegram',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  executionMode: 'container',
});

const mainScope = resolveRuntimeScopePaths('workspace-a');
const agentScope = resolveRuntimeScopePaths('workspace-a', { agentId: 'agent-1' });

for (const dir of [
  mainScope.claudeSessionDir,
  mainScope.codexHomeDir,
  agentScope.claudeSessionDir,
  agentScope.codexHomeDir,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(path.join(mainScope.claudeSessionDir, 'settings.json'), '{}');
fs.writeFileSync(path.join(mainScope.claudeSessionDir, 'transcript.jsonl'), 'main');
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'config.toml'), 'model = "gpt-5"');
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'thread.json'), 'main-thread');

fs.writeFileSync(path.join(agentScope.claudeSessionDir, 'settings.json'), '{}');
fs.writeFileSync(path.join(agentScope.claudeSessionDir, 'transcript.jsonl'), 'agent');
fs.writeFileSync(path.join(agentScope.codexHomeDir, 'config.toml'), 'model = "gpt-5"');
fs.writeFileSync(path.join(agentScope.codexHomeDir, 'thread.json'), 'agent-thread');

setSession('workspace-a', 'main-thread', undefined, 'codex_app_server');
setSession('workspace-a', 'agent-thread', 'agent-1', 'codex_app_server');

const mainStops = [];
const mainBroadcasts = [];
const mainCursors = [];
await executeSessionReset(
  'web:workspace-a',
  'workspace-a',
  {
    queue: {
      stopGroup: async (jid) => {
        mainStops.push(jid);
      },
    },
    sessions: {
      'workspace-a': { sessionId: 'main-thread', runtime: 'codex_app_server' },
    },
    broadcast: (jid, msg) => {
      mainBroadcasts.push({ jid, msg });
    },
    setLastAgentTimestamp: (jid, cursor) => {
      mainCursors.push({ jid, cursor });
    },
  },
);

assert.deepEqual(mainStops.sort(), ['telegram:workspace-a', 'web:workspace-a']);
assert.equal(getRuntimeSession('workspace-a'), undefined);
assert.deepEqual(getRuntimeSession('workspace-a', 'agent-1'), {
  sessionId: 'agent-thread',
  runtime: 'codex_app_server',
});
assert.ok(fs.existsSync(path.join(mainScope.claudeSessionDir, 'settings.json')));
assert.ok(!fs.existsSync(path.join(mainScope.claudeSessionDir, 'transcript.jsonl')));
assert.ok(fs.existsSync(path.join(mainScope.codexHomeDir, 'config.toml')));
assert.ok(!fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')));
assert.ok(fs.existsSync(path.join(agentScope.claudeSessionDir, 'transcript.jsonl')));
assert.ok(fs.existsSync(path.join(agentScope.codexHomeDir, 'thread.json')));
assert.equal(mainBroadcasts[0]?.jid, 'web:workspace-a');
assert.equal(mainBroadcasts[0]?.msg.content, 'context_reset');
assert.deepEqual(
  mainCursors.map((entry) => entry.jid).sort(),
  ['telegram:workspace-a', 'web:workspace-a'],
);

fs.writeFileSync(path.join(mainScope.claudeSessionDir, 'transcript.jsonl'), 'main-again');
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'thread.json'), 'main-thread');
fs.writeFileSync(path.join(agentScope.claudeSessionDir, 'transcript.jsonl'), 'agent-again');
fs.writeFileSync(path.join(agentScope.codexHomeDir, 'thread.json'), 'agent-thread');
setSession('workspace-a', 'main-thread-2', undefined, 'codex_app_server');
setSession('workspace-a', 'agent-thread-2', 'agent-1', 'codex_app_server');

const agentStops = [];
const agentBroadcasts = [];
const agentCursors = [];
await executeSessionReset(
  'web:workspace-a',
  'workspace-a',
  {
    queue: {
      stopGroup: async (jid) => {
        agentStops.push(jid);
      },
    },
    sessions: {
      'workspace-a': { sessionId: 'main-thread-2', runtime: 'codex_app_server' },
    },
    broadcast: (jid, msg) => {
      agentBroadcasts.push({ jid, msg });
    },
    setLastAgentTimestamp: (jid, cursor) => {
      agentCursors.push({ jid, cursor });
    },
  },
  'agent-1',
);

assert.deepEqual(agentStops, ['web:workspace-a#agent:agent-1']);
assert.deepEqual(getRuntimeSession('workspace-a'), {
  sessionId: 'main-thread-2',
  runtime: 'codex_app_server',
});
assert.equal(getRuntimeSession('workspace-a', 'agent-1'), undefined);
assert.ok(fs.existsSync(path.join(mainScope.claudeSessionDir, 'transcript.jsonl')));
assert.ok(fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')));
assert.ok(!fs.existsSync(path.join(agentScope.claudeSessionDir, 'transcript.jsonl')));
assert.ok(!fs.existsSync(path.join(agentScope.codexHomeDir, 'thread.json')));
assert.equal(agentBroadcasts[0]?.jid, 'web:workspace-a#agent:agent-1');
assert.equal(agentBroadcasts[0]?.msg.content, 'context_reset');
assert.deepEqual(agentCursors.map((entry) => entry.jid), [
  'web:workspace-a#agent:agent-1',
]);

console.log('✅ session reset scope semantics checks passed');

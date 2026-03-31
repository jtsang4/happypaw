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
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'commands.js')
);
const { GroupQueue } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'group-queue.js')
);
const { resolveRuntimeScopePaths } = await import(
  path.join(repoRoot, 'dist', 'features', 'execution', 'container-runner.js')
);
const {
  initDatabase,
  closeDatabase,
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
const secondaryScope = resolveRuntimeScopePaths('workspace-a', {
  conversationId: 'telegram:workspace-a',
});
const agentScope = resolveRuntimeScopePaths('workspace-a', { agentId: 'agent-1' });

for (const dir of [
  mainScope.codexHomeDir,
  secondaryScope.codexHomeDir,
  agentScope.codexHomeDir,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(path.join(mainScope.codexHomeDir, 'config.toml'), 'model = "gpt-5"');
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'thread.json'), 'main-thread');

fs.writeFileSync(path.join(secondaryScope.codexHomeDir, 'config.toml'), 'model = "gpt-5"');
fs.writeFileSync(path.join(secondaryScope.codexHomeDir, 'thread.json'), 'telegram-thread');

fs.writeFileSync(path.join(agentScope.codexHomeDir, 'config.toml'), 'model = "gpt-5"');
fs.writeFileSync(path.join(agentScope.codexHomeDir, 'thread.json'), 'agent-thread');

setSession('workspace-a', 'main-thread');
setSession('workspace-a', 'telegram-thread', {
  conversationId: 'telegram:workspace-a',
});
setSession('workspace-a', 'agent-thread', 'agent-1');

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
      'workspace-a': { sessionId: 'main-thread' },
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
assert.deepEqual(getRuntimeSession('workspace-a', {
  conversationId: 'telegram:workspace-a',
}), {
  sessionId: 'telegram-thread',
});
assert.deepEqual(getRuntimeSession('workspace-a', 'agent-1'), {
  sessionId: 'agent-thread',
});
assert.ok(fs.existsSync(path.join(mainScope.codexHomeDir, 'config.toml')));
assert.ok(!fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')));
assert.ok(fs.existsSync(path.join(secondaryScope.codexHomeDir, 'thread.json')));
assert.ok(fs.existsSync(path.join(agentScope.codexHomeDir, 'thread.json')));
assert.equal(mainBroadcasts[0]?.jid, 'web:workspace-a');
assert.equal(mainBroadcasts[0]?.msg.content, 'context_reset');
assert.deepEqual(
  mainCursors.map((entry) => entry.jid).sort(),
  ['telegram:workspace-a', 'web:workspace-a'],
);

fs.writeFileSync(path.join(mainScope.codexHomeDir, 'thread.json'), 'main-thread');
fs.writeFileSync(
  path.join(secondaryScope.codexHomeDir, 'thread.json'),
  'telegram-thread',
);
setSession('workspace-a', 'main-thread-2');
setSession('workspace-a', 'telegram-thread-2', {
  conversationId: 'telegram:workspace-a',
});

const secondaryStops = [];
const secondaryBroadcasts = [];
const secondaryCursors = [];
await executeSessionReset(
  'telegram:workspace-a',
  'workspace-a',
  {
    queue: {
      stopGroup: async (jid) => {
        secondaryStops.push(jid);
      },
    },
    sessions: {
      'workspace-a': { sessionId: 'main-thread-2' },
    },
    broadcast: (jid, msg) => {
      secondaryBroadcasts.push({ jid, msg });
    },
    setLastAgentTimestamp: (jid, cursor) => {
      secondaryCursors.push({ jid, cursor });
    },
  },
);

assert.deepEqual(
  secondaryStops,
  ['telegram:workspace-a'],
  'secondary reset should stop only the targeted secondary conversation',
);
assert.deepEqual(getRuntimeSession('workspace-a'), {
  sessionId: 'main-thread-2',
});
assert.equal(
  getRuntimeSession('workspace-a', {
    conversationId: 'telegram:workspace-a',
  }),
  undefined,
);
assert.ok(
  fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')),
  'secondary reset should preserve workspace main runtime files',
);
assert.ok(
  !fs.existsSync(path.join(secondaryScope.codexHomeDir, 'thread.json')),
  'secondary reset should clear only the targeted secondary runtime files',
);
assert.equal(secondaryBroadcasts[0]?.jid, 'telegram:workspace-a');
assert.equal(secondaryBroadcasts[0]?.msg.content, 'context_reset');
assert.deepEqual(secondaryCursors.map((entry) => entry.jid), [
  'telegram:workspace-a',
]);

const queue = new GroupQueue();
queue.setSerializationKeyResolver((jid) =>
  jid === 'web:workspace-a' || jid === 'telegram:workspace-a'
    ? 'workspace-a'
    : jid,
);
const queueMainState = queue.getGroup('web:workspace-a');
queueMainState.active = true;
queueMainState.groupFolder = 'workspace-a';
const siblingStopTargets = [];
queue.closeStdin = (jid) => {
  siblingStopTargets.push(jid);
  queueMainState.active = false;
};

await queue.stopGroup('telegram:workspace-a', { force: true, exact: true });

assert.deepEqual(
  siblingStopTargets,
  [],
  'targeted secondary reset must not shut down an unrelated active main runner',
);

fs.writeFileSync(path.join(agentScope.codexHomeDir, 'thread.json'), 'agent-thread');
setSession('workspace-a', 'main-thread-3');
setSession('workspace-a', 'telegram-thread-3', {
  conversationId: 'telegram:workspace-a',
});
fs.writeFileSync(
  path.join(secondaryScope.codexHomeDir, 'thread.json'),
  'telegram-thread',
);
setSession('workspace-a', 'agent-thread-2', 'agent-1');

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
      'workspace-a': { sessionId: 'main-thread-3' },
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
  sessionId: 'main-thread-3',
});
assert.deepEqual(getRuntimeSession('workspace-a', {
  conversationId: 'telegram:workspace-a',
}), {
  sessionId: 'telegram-thread-3',
});
assert.equal(getRuntimeSession('workspace-a', 'agent-1'), undefined);
assert.ok(fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')));
assert.ok(fs.existsSync(path.join(secondaryScope.codexHomeDir, 'thread.json')));
assert.ok(!fs.existsSync(path.join(agentScope.codexHomeDir, 'thread.json')));
assert.equal(agentBroadcasts[0]?.jid, 'web:workspace-a#agent:agent-1');
assert.equal(agentBroadcasts[0]?.msg.content, 'context_reset');
assert.deepEqual(agentCursors.map((entry) => entry.jid), [
  'web:workspace-a#agent:agent-1',
]);

console.log('✅ session reset scope semantics checks passed');
closeDatabase();

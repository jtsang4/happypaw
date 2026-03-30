#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-post-reset-history-'),
);

process.chdir(tempRoot);

const { executeSessionReset } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'commands.js')
);
const {
  initDatabase,
  closeDatabase,
  setRegisteredGroup,
  setSession,
  getRuntimeSession,
} = await import(path.join(repoRoot, 'dist', 'db.js'));
const { resolveRuntimeScopePaths } = await import(
  path.join(repoRoot, 'dist', 'features', 'execution', 'container-runner.js')
);

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
for (const dir of [mainScope.codexHomeDir, secondaryScope.codexHomeDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'thread.json'), 'main-thread-before');
fs.writeFileSync(
  path.join(secondaryScope.codexHomeDir, 'thread.json'),
  'secondary-thread-before',
);

setSession('workspace-a', 'main-thread-before');
setSession('workspace-a', 'secondary-thread-before', {
  conversationId: 'telegram:workspace-a',
});

await executeSessionReset(
  'telegram:workspace-a',
  'workspace-a',
  {
    queue: {
      stopGroup: async () => {},
    },
    sessions: {
      'workspace-a': { sessionId: 'main-thread-before' },
    },
    broadcast: () => {},
    setLastAgentTimestamp: () => {},
  },
);

assert.deepEqual(getRuntimeSession('workspace-a'), {
  sessionId: 'main-thread-before',
});
assert.equal(
  getRuntimeSession('workspace-a', {
    conversationId: 'telegram:workspace-a',
  }),
  undefined,
  'reset conversation should lose its prior history mapping',
);
assert.ok(
  fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')),
  'untouched main conversation should preserve prior runtime files',
);
assert.ok(
  !fs.existsSync(path.join(secondaryScope.codexHomeDir, 'thread.json')),
  'targeted secondary reset should clear only its own runtime files',
);

setSession('workspace-a', 'secondary-thread-after', {
  conversationId: 'telegram:workspace-a',
});

assert.deepEqual(getRuntimeSession('workspace-a'), {
  sessionId: 'main-thread-before',
});
assert.deepEqual(
  getRuntimeSession('workspace-a', {
    conversationId: 'telegram:workspace-a',
  }),
  {
    sessionId: 'secondary-thread-after',
  },
  'post-reset activation should start fresh history only for the reset conversation',
);

closeDatabase();
console.log('✅ post-reset history targeting checks passed');

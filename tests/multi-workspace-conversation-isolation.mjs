#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-multi-workspace-conversation-'),
);

process.chdir(tempRoot);

const {
  initDatabase,
  closeDatabase,
  createAgent,
  deleteAgent,
  getRuntimeSession,
  setSession,
} = await import(path.join(repoRoot, 'dist', 'db.js'));

initDatabase();

createAgent({
  id: 'agent-shared',
  group_folder: 'workspace-a',
  chat_jid: 'web:workspace-a',
  name: 'Shared agent in workspace A',
  prompt: 'Investigate workspace isolation',
  status: 'idle',
  kind: 'conversation',
  created_by: null,
  created_at: new Date().toISOString(),
  completed_at: null,
  result_summary: null,
  last_im_jid: null,
  spawned_from_jid: null,
});

setSession('workspace-a', 'workspace-a-thread', 'agent-shared');
setSession('workspace-b', 'workspace-b-thread', 'agent-shared');

deleteAgent('agent-shared', 'workspace-a');

assert.equal(getRuntimeSession('workspace-a', 'agent-shared'), undefined);
assert.deepEqual(getRuntimeSession('workspace-b', 'agent-shared'), {
  sessionId: 'workspace-b-thread',
});

closeDatabase();

console.log('✅ multi-workspace conversation isolation checks passed');

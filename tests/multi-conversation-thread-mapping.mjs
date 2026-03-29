#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-multi-conversation-thread-'),
);

process.chdir(tempRoot);

const { initDatabase, closeDatabase, setSession, getRuntimeSession, deleteSession } =
  await import(path.join(repoRoot, 'dist', 'db.js'));
const { default: Database } = await import(
  path.join(repoRoot, 'dist', 'shared', 'db', 'sqlite-compat.js')
);

initDatabase();

setSession('workspace-a', 'main-thread');
setSession('workspace-a', 'conversation-a-thread', {
  conversationId: 'conversation-a',
});
setSession('workspace-a', 'conversation-b-thread', {
  conversationId: 'conversation-b',
});

assert.deepEqual(getRuntimeSession('workspace-a'), {
  sessionId: 'main-thread',
});
assert.deepEqual(
  getRuntimeSession('workspace-a', {
    conversationId: 'conversation-a',
  }),
  {
    sessionId: 'conversation-a-thread',
  },
);
assert.deepEqual(
  getRuntimeSession('workspace-a', {
    conversationId: 'conversation-b',
  }),
  {
    sessionId: 'conversation-b-thread',
  },
);

deleteSession('workspace-a', {
  conversationId: 'conversation-a',
});
assert.equal(
  getRuntimeSession('workspace-a', {
    conversationId: 'conversation-a',
  }),
  undefined,
);
assert.deepEqual(
  getRuntimeSession('workspace-a', {
    conversationId: 'conversation-b',
  }),
  {
    sessionId: 'conversation-b-thread',
  },
);
assert.deepEqual(getRuntimeSession('workspace-a'), {
  sessionId: 'main-thread',
});

const dbPath = path.join(tempRoot, 'data', 'db', 'messages.db');
const sqlite = new Database(dbPath);
const rows = sqlite
  .prepare(
    `
      SELECT group_folder, agent_id, conversation_id, session_id
      FROM sessions
      WHERE group_folder = ?
      ORDER BY agent_id, conversation_id
    `,
  )
  .all('workspace-a');

assert.deepEqual(rows, [
  {
    group_folder: 'workspace-a',
    agent_id: '',
    conversation_id: '',
    session_id: 'main-thread',
  },
  {
    group_folder: 'workspace-a',
    agent_id: '',
    conversation_id: 'conversation-b',
    session_id: 'conversation-b-thread',
  },
]);

sqlite.close();
closeDatabase();

console.log('✅ multi-conversation thread mapping checks passed');

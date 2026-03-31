#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(
    os.tmpdir(),
    'happypaw-pending-secondary-conversation-restart-recovery-',
  ),
);

process.chdir(tempRoot);

const {
  closeDatabase,
  ensureChatExists,
  getMessagesSince,
  getRuntimeSession,
  initDatabase,
  setRegisteredGroup,
  setSession,
  storeMessageDirect,
} = await import(path.join(repoRoot, 'dist', 'db.js'));
const { recoverPendingMessages } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'recovery.js')
);
const { clearPersistedRuntimeStateForRecovery } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'chat-runtime',
    'runtime-state-cleanup.js',
  )
);
const { resolveRuntimeScopePaths } = await import(
  path.join(repoRoot, 'dist', 'features', 'execution', 'container-runner.js')
);

initDatabase();

const chatJid = 'telegram:workspace-main';
const groupFolder = 'workspace-main';
const conversationScope = { conversationId: chatJid };

setRegisteredGroup(chatJid, {
  name: 'Workspace Main Telegram',
  folder: groupFolder,
  added_at: new Date().toISOString(),
  executionMode: 'host',
});
ensureChatExists(chatJid);

const sessions = /** @type {Record<string, {sessionId: string}>} */ ({
  [groupFolder]: {
    sessionId: 'main-thread',
  },
});

setSession(groupFolder, 'main-thread');
setSession(groupFolder, 'secondary-thread', conversationScope);

const mainScope = resolveRuntimeScopePaths(groupFolder);
const secondaryScope = resolveRuntimeScopePaths(groupFolder, conversationScope);
fs.mkdirSync(mainScope.codexHomeDir, { recursive: true });
fs.mkdirSync(secondaryScope.codexHomeDir, { recursive: true });
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'config.toml'), 'model=1');
fs.writeFileSync(
  path.join(mainScope.codexHomeDir, 'thread.json'),
  'main-thread',
);
fs.writeFileSync(
  path.join(secondaryScope.codexHomeDir, 'config.toml'),
  'model=1',
);
fs.writeFileSync(
  path.join(secondaryScope.codexHomeDir, 'thread.json'),
  'secondary-thread',
);

storeMessageDirect(
  'pending-secondary-message',
  chatJid,
  'user-1',
  'User One',
  'Please resume the secondary conversation',
  new Date().toISOString(),
  false,
);

const queuedChats = [];
const recoveryGroups = new Set();

recoverPendingMessages({
  logger: {
    info() {},
    warn() {},
    debug() {},
  },
  queue: {
    enqueueMessageCheck(recoveredChatJid) {
      queuedChats.push(recoveredChatJid);
    },
  },
  recoveryGroups,
  getRegisteredGroups: () => ({
    [chatJid]: {
      name: 'Workspace Main Telegram',
      folder: groupFolder,
      added_at: new Date().toISOString(),
      executionMode: 'host',
    },
  }),
  getLastCommittedCursor: () => ({
    [chatJid]: {
      timestamp: '',
      id: '',
    },
  }),
  getSessions: () => sessions,
  getMessagesSince,
  getRuntimeSession,
  clearPersistedRuntimeStateForRecovery,
});

assert.deepEqual(queuedChats, [chatJid]);
assert.deepEqual([...recoveryGroups], [chatJid]);
assert.deepEqual(
  getRuntimeSession(groupFolder),
  {
    sessionId: 'main-thread',
  },
  'restart recovery must preserve the default main conversation mapping',
);
assert.equal(
  getRuntimeSession(groupFolder, conversationScope),
  undefined,
  'restart recovery should clear the stale secondary conversation mapping',
);
assert.deepEqual(sessions, {
  [groupFolder]: {
    sessionId: 'main-thread',
  },
});
assert.ok(
  fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')),
  'restart recovery must preserve main conversation runtime files',
);
assert.ok(
  !fs.existsSync(path.join(secondaryScope.codexHomeDir, 'thread.json')),
  'restart recovery should clear stale secondary conversation runtime files',
);

closeDatabase();
console.log('✅ pending secondary conversation restart recovery checks passed');

#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-unconsumed-ipc-recovery-'),
);

process.chdir(tempRoot);

const { GroupQueue } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'group-queue.js')
);

const queue = new GroupQueue();
const groupJid = 'web:workspace-a';
const groupFolder = 'workspace-a';

const inputDir = path.join(tempRoot, 'data', 'ipc', groupFolder, 'input');
fs.mkdirSync(inputDir, { recursive: true });
fs.writeFileSync(
  path.join(inputDir, 'pending-message.json'),
  JSON.stringify({ type: 'message', text: 'recover me' }),
);
fs.writeFileSync(path.join(inputDir, '_close'), '');

const state = queue.getStatus().groups.find((entry) => entry.jid === groupJid);
assert.equal(state, undefined, 'group state should start empty for this focused recovery test');

const internalState = queue.getGroup(groupJid);
internalState.groupFolder = groupFolder;
internalState.pendingMessages = false;

queue.cleanupIpcSentinels(groupFolder, null, null);
queue.recoverUnconsumedIpc(groupJid, internalState, 'agent exit');

const status = queue.getStatus();
const recoveredState = status.groups.find((entry) => entry.jid === groupJid);
assert.ok(recoveredState, 'queue should track group state after recovery');
assert.equal(
  recoveredState?.pendingMessages,
  true,
  'unconsumed IPC work should mark the conversation pending for requeue',
);
assert.ok(
  !fs.existsSync(path.join(inputDir, '_close')),
  'stale _close sentinel should be removed during cleanup',
);
assert.ok(
  fs.existsSync(path.join(inputDir, 'pending-message.json')),
  'unconsumed IPC payload should remain available for the requeued run',
);

console.log('✅ unconsumed IPC recovery checks passed');

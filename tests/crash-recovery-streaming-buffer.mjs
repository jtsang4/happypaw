#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-crash-recovery-streaming-buffer-'),
);

process.chdir(tempRoot);

const {
  initDatabase,
  closeDatabase,
  ensureChatExists,
  getMessagesPage,
  storeMessageDirect,
} =
  await import(path.join(repoRoot, 'dist', 'db.js'));
const { createStreamingBufferManager, buildInterruptedReply } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'recovery.js'),
);

initDatabase();

const assistantName = 'HappyPaw';
const chatJid = 'web:workspace-a';
ensureChatExists(chatJid);

const manager = createStreamingBufferManager({
  dataDir: path.join(tempRoot, 'data'),
  assistantName,
  shutdownSavedJids: new Set(),
  logger: {
    info() {},
    warn() {},
    debug() {},
  },
  getActiveStreamingTexts: () => new Map(),
  ensureChatExists,
  storeMessageDirect,
});

const streamingBufferDir = path.join(tempRoot, 'data', 'streaming-buffer');
fs.mkdirSync(streamingBufferDir, { recursive: true });
const encoded = Buffer.from(chatJid).toString('base64url');
fs.writeFileSync(path.join(streamingBufferDir, `${encoded}.txt`), 'partial reply');

manager.recoverStreamingBuffer();

let messages = getMessagesPage(chatJid);
assert.equal(messages.length, 1, 'crash recovery should restore the interrupted partial once');
assert.equal(
  messages[0].content,
  buildInterruptedReply('partial reply'),
  'recovered interrupted text should match the persisted partial content',
);
assert.equal(messages[0].source_kind, 'interrupt_partial');
assert.equal(messages[0].finalization_reason, 'crash_recovery');
assert.ok(
  !fs.existsSync(path.join(streamingBufferDir, `${encoded}.txt`)),
  'crash recovery should clear the consumed streaming buffer file',
);

manager.recoverStreamingBuffer();
messages = getMessagesPage(chatJid);
assert.equal(
  messages.length,
  1,
  'crash recovery must not replay the same interrupted partial twice',
);

console.log('✅ crash recovery streaming buffer checks passed');
closeDatabase();

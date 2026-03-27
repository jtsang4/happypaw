#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

const feishu = await import(
  pathToFileURL(path.join(repoRoot, 'dist', 'feishu.js')).href
);
const streaming = await import(
  pathToFileURL(path.join(repoRoot, 'dist', 'feishu-streaming-card.js')).href
);

const expectedFeishuExports = [
  'createFeishuConnection',
  'connectFeishu',
  'sendFeishuMessage',
  'setFeishuTyping',
  'syncFeishuGroups',
  'isFeishuConnected',
  'stopFeishu',
];
for (const name of expectedFeishuExports) {
  assert.equal(typeof feishu[name], 'function', `exports ${name}`);
}

const connection = feishu.createFeishuConnection({
  appId: 'test-app-id',
  appSecret: 'test-app-secret',
});
for (const name of [
  'connect',
  'stop',
  'sendMessage',
  'sendImage',
  'sendFile',
  'sendReaction',
  'clearAckReaction',
  'isConnected',
  'syncGroups',
  'getChatInfo',
  'getLarkClient',
  'getLastMessageId',
]) {
  assert.equal(typeof connection[name], 'function', `connection.${name}`);
}

assert.equal(typeof streaming.StreamingCardController, 'function');
for (const name of [
  'registerMessageIdMapping',
  'resolveJidByMessageId',
  'unregisterMessageId',
  'registerStreamingSession',
  'unregisterStreamingSession',
  'getStreamingSession',
  'hasActiveStreamingSession',
  'abortAllStreamingSessions',
]) {
  assert.equal(typeof streaming[name], 'function', `exports ${name}`);
}

streaming.registerMessageIdMapping('msg-alpha', 'feishu:alpha');
assert.equal(
  streaming.resolveJidByMessageId('msg-alpha'),
  'feishu:alpha',
  'message mapping resolves registered jid',
);
streaming.unregisterMessageId('msg-alpha');
assert.equal(
  streaming.resolveJidByMessageId('msg-alpha'),
  undefined,
  'unregisterMessageId removes mapping',
);

const replacedReasons = [];
const firstSession = {
  isActive: () => true,
  abort: async (reason) => {
    replacedReasons.push(reason);
  },
  getAllMessageIds: () => ['msg-one', 'msg-two'],
};
const secondSession = {
  isActive: () => true,
  abort: async () => {},
  getAllMessageIds: () => ['msg-three'],
};

streaming.registerMessageIdMapping('msg-one', 'feishu:chat-1');
streaming.registerMessageIdMapping('msg-two', 'feishu:chat-1');
streaming.registerStreamingSession('feishu:chat-1', firstSession);
assert.equal(
  streaming.getStreamingSession('feishu:chat-1'),
  firstSession,
  'registerStreamingSession stores active session',
);
assert.equal(
  streaming.hasActiveStreamingSession('feishu:chat-1'),
  true,
  'hasActiveStreamingSession reflects active replacement target',
);

streaming.registerStreamingSession('feishu:chat-1', secondSession);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(
  replacedReasons,
  ['新的回复已开始'],
  'replacing a session aborts the previous active one with the expected reason',
);
assert.equal(
  streaming.getStreamingSession('feishu:chat-1'),
  secondSession,
  'new session replaces previous session',
);

streaming.unregisterStreamingSession('feishu:chat-1');
assert.equal(
  streaming.getStreamingSession('feishu:chat-1'),
  undefined,
  'unregisterStreamingSession removes stored session',
);
assert.equal(
  streaming.resolveJidByMessageId('msg-three'),
  undefined,
  'unregisterStreamingSession removes the current session message mappings',
);

const abortedDuringShutdown = [];
const activeSession = {
  isActive: () => true,
  abort: async (reason) => {
    abortedDuringShutdown.push(reason);
  },
  getAllMessageIds: () => ['msg-shutdown'],
};
const inactiveSession = {
  isActive: () => false,
  abort: async () => {
    throw new Error('inactive session should not be aborted');
  },
  getAllMessageIds: () => ['msg-idle'],
};

streaming.registerMessageIdMapping('msg-shutdown', 'feishu:shutdown');
streaming.registerMessageIdMapping('msg-idle', 'feishu:idle');
streaming.registerStreamingSession('feishu:shutdown', activeSession);
streaming.registerStreamingSession('feishu:idle', inactiveSession);
await streaming.abortAllStreamingSessions('服务维护中');

assert.deepEqual(
  abortedDuringShutdown,
  ['服务维护中'],
  'abortAllStreamingSessions aborts active sessions with the provided reason',
);
assert.equal(
  streaming.getStreamingSession('feishu:shutdown'),
  undefined,
  'abortAllStreamingSessions clears active session registry',
);
assert.equal(
  streaming.getStreamingSession('feishu:idle'),
  undefined,
  'abortAllStreamingSessions clears inactive sessions as well',
);
assert.equal(
  streaming.resolveJidByMessageId('msg-shutdown'),
  undefined,
  'abortAllStreamingSessions removes mappings for active sessions',
);
assert.equal(
  streaming.resolveJidByMessageId('msg-idle'),
  undefined,
  'abortAllStreamingSessions removes mappings for inactive sessions',
);

console.log('✅ feishu module surface checks passed');
process.exit(0);

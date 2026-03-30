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
  closeDatabase,
  ensureChatExists,
  getRuntimeSession,
  initDatabase,
  setRegisteredGroup,
  setSession,
  storeMessageDirect,
} = await import(path.join(repoRoot, 'dist', 'db.js'));
const { createMessageIngress } = await import(
  path.join(repoRoot, 'dist', 'app', 'web', 'message-ingress.js'),
);
const { createMessageLoop } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'message-loop.js'),
);
const { createMainConversationRuntime } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'chat-runtime',
    'main-conversation-runtime.js',
  ),
);
const { executeSessionReset } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'commands.js'),
);

initDatabase();

const registeredGroups = {
  'web:workspace-a': {
    name: 'Workspace A Web',
    folder: 'workspace-a',
    added_at: new Date().toISOString(),
    executionMode: 'host',
  },
  'telegram:workspace-a': {
    name: 'Workspace A Telegram',
    folder: 'workspace-a',
    added_at: new Date().toISOString(),
    executionMode: 'host',
  },
  'web:workspace-b': {
    name: 'Workspace B Web',
    folder: 'workspace-b',
    added_at: new Date().toISOString(),
    executionMode: 'host',
  },
  'telegram:workspace-b': {
    name: 'Workspace B Telegram',
    folder: 'workspace-b',
    added_at: new Date().toISOString(),
    executionMode: 'host',
  },
};

for (const [jid, group] of Object.entries(registeredGroups)) {
  setRegisteredGroup(jid, group);
  ensureChatExists(jid);
}

setSession('workspace-a', 'workspace-a-main-thread');
setSession('workspace-a', 'workspace-a-telegram-thread', {
  conversationId: 'telegram:workspace-a',
});
setSession('workspace-b', 'workspace-b-main-thread');
setSession('workspace-b', 'workspace-b-telegram-thread', {
  conversationId: 'telegram:workspace-b',
});

const lastAgentTimestamp = {};
const ingressContexts = [];
const ingress = createMessageIngress({
  getWebDeps: () => ({
    queue: {
      sendMessage(chatJid, _message, _images, _onSent, context) {
        ingressContexts.push({ chatJid, context });
        return 'sent';
      },
      enqueueMessageCheck() {},
      markIpcInjectedMessage() {},
      closeStdin() {},
      enqueueTask() {},
    },
    getRegisteredGroups: () => registeredGroups,
    getRuntimeSession,
    formatMessages: () => '<messages></messages>',
    setLastAgentTimestamp(jid, cursor) {
      lastAgentTimestamp[jid] = cursor;
    },
    advanceGlobalCursor() {},
  }),
  broadcastNewMessage() {},
});

await ingress.handleWebUserMessage(
  'telegram:workspace-a',
  'Reactivate workspace A',
  undefined,
  'user-a',
  'User A',
);
await ingress.handleWebUserMessage(
  'telegram:workspace-b',
  'Reactivate workspace B',
  undefined,
  'user-b',
  'User B',
);

assert.deepEqual(ingressContexts, [
  {
    chatJid: 'telegram:workspace-a',
    context: {
      sessionId: 'workspace-a-telegram-thread',
      chatJid: 'telegram:workspace-a',
      replyRouteJid: null,
      sessionScope: { conversationId: 'telegram:workspace-a' },
    },
  },
  {
    chatJid: 'telegram:workspace-b',
    context: {
      sessionId: 'workspace-b-telegram-thread',
      chatJid: 'telegram:workspace-b',
      replyRouteJid: null,
      sessionScope: { conversationId: 'telegram:workspace-b' },
    },
  },
]);

storeMessageDirect(
  'telegram-a-message',
  'telegram:workspace-a',
  'user-a',
  'User A',
  'Loop workspace A',
  new Date(Date.now() + 1_000).toISOString(),
  false,
);
storeMessageDirect(
  'telegram-b-message',
  'telegram:workspace-b',
  'user-b',
  'User B',
  'Loop workspace B',
  new Date(Date.now() + 2_000).toISOString(),
  false,
);

const loopContexts = [];
let deliveredCount = 0;
let shuttingDown = false;
const { startMessageLoop } = createMessageLoop({
  queue: {
    sendMessage(chatJid, _message, _images, _onSent, context) {
      loopContexts.push({ chatJid, context });
      deliveredCount += 1;
      if (deliveredCount >= 2) {
        shuttingDown = true;
      }
      return 'sent';
    },
    enqueueMessageCheck() {},
  },
  pollInterval: 0,
  emptyCursor: { timestamp: '', id: '' },
  registeredGroups,
  lastAgentTimestamp,
  recoveryGroups: new Set(),
  getGlobalMessageCursor: () => ({ timestamp: '', id: '' }),
  setGlobalMessageCursor() {},
  saveState() {},
  setCursors() {},
  getStuckRunnerCheckCounter: () => 0,
  resetStuckRunnerCheckCounter() {},
  incrementStuckRunnerCheckCounter: () => 0,
  stuckRunnerCheckIntervalPolls: 100,
  recoverStuckPendingGroups() {},
  isShuttingDown: () => shuttingDown,
  formatMessages: () => '<messages></messages>',
  collectMessageImages: () => [],
  isGroupShared: () => false,
  sendBillingDeniedMessage: () => 'billing-blocked',
  imManager: {
    async sendMessage() {},
  },
  getRuntimeSession,
  activeRouteUpdaters: new Map(),
});

await startMessageLoop();

assert.deepEqual(loopContexts, [
  {
    chatJid: 'telegram:workspace-a',
    context: {
      sessionId: 'workspace-a-telegram-thread',
      chatJid: 'telegram:workspace-a',
      replyRouteJid: 'telegram:workspace-a',
      sessionScope: { conversationId: 'telegram:workspace-a' },
    },
  },
  {
    chatJid: 'telegram:workspace-b',
    context: {
      sessionId: 'workspace-b-telegram-thread',
      chatJid: 'telegram:workspace-b',
      replyRouteJid: 'telegram:workspace-b',
      sessionScope: { conversationId: 'telegram:workspace-b' },
    },
  },
]);

const runtimeScopes = [];
const runtime = createMainConversationRuntime({
  registeredGroups,
  sessions: {
    'workspace-a': { sessionId: 'workspace-a-main-thread' },
    'workspace-b': { sessionId: 'workspace-b-main-thread' },
  },
  lastAgentTimestamp: {},
  recoveryGroups: new Set(),
  activeRouteUpdaters: new Map(),
  shutdownSavedJids: new Set(),
  consecutiveOomExits: {},
  oomExitRe: /OOM/i,
  oomAutoResetThreshold: 3,
  resolveEffectiveGroup: (group) => ({ effectiveGroup: group, isHome: false }),
  setActiveImReplyRoute() {},
  clearActiveImReplyRoute() {},
  advanceCursors() {},
  isGroupShared: () => false,
  closeStdin() {},
  async runAgent(
    group,
    _prompt,
    chatJid,
    _turnId,
    _onOutput,
    _images,
    _replyRouteJid,
    sessionScope,
  ) {
    runtimeScopes.push({
      folder: group.folder,
      chatJid,
      sessionScope,
    });
    return { status: 'success' };
  },
  getEffectiveRuntime: () => 'codex_app_server',
  sendBillingDeniedMessage: () => 'billing-blocked',
  async setTyping() {},
  async sendMessage() {
    return undefined;
  },
  sendSystemMessage() {},
  extractLocalImImagePaths: () => [],
  sendImWithFailTracking() {},
  writeUsageRecords() {},
  getAgentReplyRouteJid: () => undefined,
});

await runtime.processGroupMessages('telegram:workspace-a');
await runtime.processGroupMessages('telegram:workspace-b');

assert.deepEqual(runtimeScopes, [
  {
    folder: 'workspace-a',
    chatJid: 'telegram:workspace-a',
    sessionScope: { conversationId: 'telegram:workspace-a' },
  },
  {
    folder: 'workspace-b',
    chatJid: 'telegram:workspace-b',
    sessionScope: { conversationId: 'telegram:workspace-b' },
  },
]);

const resetBroadcasts = [];
const resetTimestamps = [];
await executeSessionReset('telegram:workspace-a', 'workspace-a', {
  queue: {
    async stopGroup() {},
  },
  sessions: {
    'workspace-a': { sessionId: 'workspace-a-main-thread' },
    'workspace-b': { sessionId: 'workspace-b-main-thread' },
  },
  broadcast(jid, msg) {
    resetBroadcasts.push({ jid, content: msg.content });
  },
  setLastAgentTimestamp(jid, cursor) {
    resetTimestamps.push({ jid, cursor });
  },
});

assert.equal(
  getRuntimeSession('workspace-a'),
  undefined,
  'workspace A reset must clear only workspace A runtime mapping',
);
assert.deepEqual(
  getRuntimeSession('workspace-b', {
    conversationId: 'telegram:workspace-b',
  }),
  {
    sessionId: 'workspace-b-telegram-thread',
  },
  'workspace B conversation mapping must survive workspace A reset',
);
assert.deepEqual(
  getRuntimeSession('workspace-b'),
  {
    sessionId: 'workspace-b-main-thread',
  },
  'workspace B main runtime mapping must also survive workspace A reset',
);
assert.equal(
  resetBroadcasts.some(
    (entry) =>
      entry.jid === 'telegram:workspace-a' &&
      entry.content === 'context_reset',
  ),
  true,
);
assert.equal(
  resetTimestamps.some((entry) => entry.jid === 'telegram:workspace-b'),
  false,
  'workspace A reset must not advance workspace B cursor state',
);

closeDatabase();

console.log('✅ multi-workspace conversation isolation checks passed');

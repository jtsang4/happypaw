#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-conversation-reactivation-'),
);

process.chdir(tempRoot);

const {
  closeDatabase,
  ensureChatExists,
  initDatabase,
  setRegisteredGroup,
  setSession,
  storeMessageDirect,
} = await import(path.join(repoRoot, 'dist', 'db.js'));
const { createMessageIngress } = await import(
  path.join(repoRoot, 'dist', 'app', 'web', 'message-ingress.js')
);
const { createMessageLoop } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'message-loop.js')
);
const { createMainConversationRuntime } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'chat-runtime',
    'main-conversation-runtime.js',
  )
);

initDatabase();

const lastAgentTimestamp = {};

const registeredGroups = {
  'web:workspace-a': {
    name: 'Workspace A',
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
  'qq:workspace-a': {
    name: 'Workspace A QQ',
    folder: 'workspace-a',
    added_at: new Date().toISOString(),
    executionMode: 'host',
  },
};

for (const [jid, group] of Object.entries(registeredGroups)) {
  setRegisteredGroup(jid, group);
  ensureChatExists(jid);
}

setSession('workspace-a', 'main-thread');
setSession('workspace-a', 'conversation-a-thread', {
  conversationId: 'telegram:workspace-a',
});
setSession('workspace-a', 'conversation-b-thread', {
  conversationId: 'qq:workspace-a',
});

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
    getRuntimeSession(groupFolder, scope) {
      if (groupFolder !== 'workspace-a') return undefined;
      if (scope?.conversationId === 'telegram:workspace-a') {
        return { sessionId: 'conversation-a-thread' };
      }
      if (scope?.conversationId === 'qq:workspace-a') {
        return { sessionId: 'conversation-b-thread' };
      }
      return { sessionId: 'main-thread' };
    },
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
  'Reactivate telegram conversation',
  undefined,
  'user-1',
  'User One',
);

assert.deepEqual(ingressContexts, [
  {
    chatJid: 'telegram:workspace-a',
    context: {
      sessionId: 'conversation-a-thread',
      chatJid: 'telegram:workspace-a',
      replyRouteJid: null,
        sessionScope: { conversationId: 'telegram:workspace-a' },
    },
  },
]);

const qqMessageId = 'qq-message-1';
const qqTimestamp = new Date().toISOString();
storeMessageDirect(
  qqMessageId,
  'qq:workspace-a',
  'user-2',
  'User Two',
  'Reactivate qq conversation',
  qqTimestamp,
  false,
);

const loopContexts = [];
let shuttingDown = false;
const { startMessageLoop } = createMessageLoop({
  queue: {
    sendMessage(chatJid, _message, _images, _onSent, context) {
      loopContexts.push({ chatJid, context });
      shuttingDown = true;
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
  getRuntimeSession(groupFolder, scope) {
    if (groupFolder !== 'workspace-a') return undefined;
    if (scope?.conversationId === 'telegram:workspace-a') {
      return { sessionId: 'conversation-a-thread' };
    }
    if (scope?.conversationId === 'qq:workspace-a') {
      return { sessionId: 'conversation-b-thread' };
    }
    return { sessionId: 'main-thread' };
  },
  activeRouteUpdaters: new Map(),
});

await startMessageLoop();

assert.deepEqual(loopContexts, [
  {
    chatJid: 'telegram:workspace-a',
    context: {
      sessionId: 'conversation-a-thread',
      chatJid: 'telegram:workspace-a',
      replyRouteJid: 'telegram:workspace-a',
      sessionScope: { conversationId: 'telegram:workspace-a' },
    },
  },
  {
    chatJid: 'qq:workspace-a',
    context: {
      sessionId: 'conversation-b-thread',
      chatJid: 'qq:workspace-a',
      replyRouteJid: 'qq:workspace-a',
        sessionScope: { conversationId: 'qq:workspace-a' },
    },
  },
]);

const runtimeScopes = [];
const runtime = createMainConversationRuntime({
  registeredGroups,
  sessions: {
    'workspace-a': { sessionId: 'main-thread' },
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
    _group,
    _prompt,
    chatJid,
    _turnId,
    _onOutput,
    _images,
    _replyRouteJid,
    sessionScope,
  ) {
    runtimeScopes.push({ chatJid, sessionScope });
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

assert.deepEqual(runtimeScopes, [
  {
    chatJid: 'telegram:workspace-a',
    sessionScope: { conversationId: 'telegram:workspace-a' },
  },
]);

closeDatabase();
console.log('✅ conversation reactivation loads the correct thread mapping');

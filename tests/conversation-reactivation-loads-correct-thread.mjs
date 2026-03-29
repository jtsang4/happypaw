#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

const { createAgentRuntimeAdapter } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'chat-runtime',
    'agent-runtime-adapter.js',
  )
);

const capturedSessionIds = [];
const lookedUpScopes = [];

const adapter = createAgentRuntimeAdapter({
  assistantName: 'HappyPaw',
  queue: {
    markRunnerActivity() {},
    markRunnerQueryIdle() {},
    registerProcess() {},
    getStatus() {
      return { groups: [] };
    },
    enqueueTask() {},
  },
  registeredGroups: {},
  sessions: {
    'workspace-a': { sessionId: 'main-thread' },
  },
  terminalWarmupInFlight: new Set(),
  getIpcRuntime: () => ({
    watchGroup() {},
    unwatchGroup() {},
  }),
  getAvailableGroups: () => [],
  getAllTasks: () => [],
  activeImReplyRoutes: new Map(),
  hasActiveStreamingSession: () => false,
  imManager: {
    async setTyping() {},
    async sendMessage() {},
  },
  getChannelType: () => null,
  ensureChatExists() {},
  storeMessageDirect() {
    return 'msg-1';
  },
  broadcastNewMessage() {},
  broadcastToWebClients() {},
  broadcastTyping() {},
  broadcastStreamEvent() {},
  extractLocalImImagePaths: () => [],
  resolveEffectiveFolder: () => 'workspace-a',
  resolveOwnerHomeFolder: () => undefined,
  getSystemSettings: () => ({
    defaultRuntime: 'codex_app_server',
    idleTimeout: 60_000,
  }),
  insertUsageRecord() {},
  setSession() {},
  getRuntimeSession: (_groupFolder, scope) => {
    lookedUpScopes.push(scope);
    if (scope?.conversationId === 'conversation-a') {
      return { sessionId: 'conversation-a-thread' };
    }
    if (scope?.conversationId === 'conversation-b') {
      return { sessionId: 'conversation-b-thread' };
    }
    return { sessionId: 'main-thread' };
  },
  async runHostAgent(_group, input) {
    capturedSessionIds.push(input.sessionId);
    return {
      status: 'success',
      result: null,
      newSessionId: input.sessionId,
    };
  },
  async runContainerAgent() {
    throw new Error('runContainerAgent should not be called in this regression');
  },
  writeTasksSnapshot() {},
  writeGroupsSnapshot() {},
});

const group = {
  name: 'Workspace A',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  executionMode: 'host',
};

await adapter.runAgent(
  group,
  'Reactivate conversation A',
  'web:workspace-a',
  'turn-a',
  undefined,
  undefined,
  undefined,
  { conversationId: 'conversation-a' },
);

await adapter.runAgent(
  group,
  'Reactivate conversation B',
  'web:workspace-a',
  'turn-b',
  undefined,
  undefined,
  undefined,
  { conversationId: 'conversation-b' },
);

assert.deepEqual(capturedSessionIds, [
  'conversation-a-thread',
  'conversation-b-thread',
]);
assert.deepEqual(lookedUpScopes, [
  { conversationId: 'conversation-a' },
  { conversationId: 'conversation-b' },
]);

console.log('✅ conversation reactivation loads the correct thread mapping');

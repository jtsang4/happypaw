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
  ),
);

const scopeKey = (scope) => scope?.conversationId || '__main__';

const sessions = new Map([
  ['__main__', 'main-thread'],
  ['conversation-a', 'thr_stale'],
  ['conversation-b', 'thr_sibling'],
]);

const setSessionCalls = [];
const capturedSessionIds = [];

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
    'workspace-a': { sessionId: sessions.get('__main__') },
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
  setSession(groupFolder, sessionId, scope) {
    setSessionCalls.push({ groupFolder, sessionId, scope });
    sessions.set(scopeKey(scope), sessionId);
  },
  getRuntimeSession(_groupFolder, scope) {
    const sessionId = sessions.get(scopeKey(scope));
    return sessionId ? { sessionId } : undefined;
  },
  async runHostAgent(_group, input) {
    capturedSessionIds.push(input.sessionId);
    return {
      status: 'success',
      result: null,
      newSessionId:
        input.sessionId === 'thr_stale' ? 'thr_fresh' : input.sessionId,
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
  'Resume stale conversation A',
  'web:workspace-a',
  'turn-a',
  undefined,
  undefined,
  undefined,
  { conversationId: 'conversation-a' },
);

assert.deepEqual(capturedSessionIds, ['thr_stale']);
assert.deepEqual(setSessionCalls, [
  {
    groupFolder: 'workspace-a',
    sessionId: 'thr_fresh',
    scope: { conversationId: 'conversation-a' },
  },
]);
assert.equal(sessions.get('conversation-a'), 'thr_fresh');
assert.equal(sessions.get('conversation-b'), 'thr_sibling');
assert.equal(sessions.get('__main__'), 'main-thread');

console.log(
  '✅ stale thread fallback updates only the targeted conversation mapping',
);

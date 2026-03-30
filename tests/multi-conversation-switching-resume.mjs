#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

import {
  startPersistentRunnerHarness,
} from './persistent-runner-test-helpers.mjs';

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

const requestScopes = [];
const turnStarts = [];
const harness = await startPersistentRunnerHarness({
  initialPrompt: '会话A首轮',
  initialChatJid: 'web:workspace-a',
  sessionId: 'thread-a',
  codexOptions: {
    repliesByText: {
      会话A首轮: '会话A首轮回复',
      会话B首轮: '会话B首轮回复',
      会话A恢复: '会话A恢复回复',
      会话B恢复: '会话B恢复回复',
    },
  },
});

const sessions = new Map([
  ['conversation-a', 'thread-a'],
  ['conversation-b', 'thread-b'],
]);

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
  sessions: {},
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
    requestScopes.push({
      phase: 'set',
      groupFolder,
      sessionId,
      scope,
    });
    if (scope?.conversationId) {
      sessions.set(scope.conversationId, sessionId);
    }
  },
  getRuntimeSession(groupFolder, scope) {
    requestScopes.push({
      phase: 'get',
      groupFolder,
      scope,
    });
    const conversationId = scope?.conversationId;
    const sessionId = conversationId ? sessions.get(conversationId) : undefined;
    return sessionId ? { sessionId } : undefined;
  },
  async runHostAgent(_group, input, onProcess, onOutput) {
    onProcess(harness.child, 'persistent-runner');
    turnStarts.push({
      prompt: input.prompt,
      sessionId: input.sessionId,
      chatJid: input.chatJid,
      replyRouteJid: input.replyRouteJid ?? null,
      turnId: input.turnId,
    });

    if (input.prompt === '会话A首轮') {
      await harness.waitForOutput(
        (entry) =>
          entry.status === 'success' && entry.result === '会话A首轮回复',
        'conversation A first response',
      );
      return {
        status: 'success',
        result: null,
        newSessionId: input.sessionId,
      };
    }

    if (input.prompt === '会话B首轮') {
      harness.sendIpcMessage('001-conversation-b.json', {
        text: input.prompt,
        sessionId: input.sessionId,
        chatJid: 'web:workspace-b',
        replyRouteJid: 'telegram:route-b',
      });
      await harness.waitForOutput(
        (entry) =>
          entry.status === 'success' && entry.result === '会话B首轮回复',
        'conversation B first response',
      );
      return {
        status: 'success',
        result: null,
        newSessionId: input.sessionId,
      };
    }

    if (input.prompt === '会话A恢复') {
      harness.sendIpcMessage('002-conversation-a-resume.json', {
        text: input.prompt,
        sessionId: input.sessionId,
        chatJid: 'web:workspace-a',
        replyRouteJid: 'telegram:route-a',
      });
      await harness.waitForOutput(
        (entry) =>
          entry.status === 'success' && entry.result === '会话A恢复回复',
        'conversation A resume response',
      );
      return {
        status: 'success',
        result: null,
        newSessionId: input.sessionId,
      };
    }

    if (input.prompt === '会话B恢复') {
      harness.sendIpcMessage('003-conversation-b-resume.json', {
        text: input.prompt,
        sessionId: input.sessionId,
        chatJid: 'web:workspace-b',
        replyRouteJid: 'telegram:route-b',
      });
      await harness.waitForOutput(
        (entry) =>
          entry.status === 'success' && entry.result === '会话B恢复回复',
        'conversation B resume response',
      );
      return {
        status: 'success',
        result: null,
        newSessionId: input.sessionId,
      };
    }

    await onOutput?.({
      status: 'success',
      result: null,
      newSessionId: input.sessionId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
    return {
      status: 'success',
      result: null,
      newSessionId: input.sessionId,
      sessionId: input.sessionId,
      turnId: input.turnId,
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

try {
  await adapter.runAgent(
    group,
    '会话A首轮',
    'web:workspace-a',
    'turn-a1',
    undefined,
    undefined,
    undefined,
    { conversationId: 'conversation-a' },
  );

  await adapter.runAgent(
    group,
    '会话B首轮',
    'web:workspace-a',
    'turn-b1',
    undefined,
    undefined,
    undefined,
    { conversationId: 'conversation-b' },
  );

  await adapter.runAgent(
    group,
    '会话A恢复',
    'web:workspace-a',
    'turn-a2',
    undefined,
    undefined,
    undefined,
    { conversationId: 'conversation-a' },
  );

  await adapter.runAgent(
    group,
    '会话B恢复',
    'web:workspace-a',
    'turn-b2',
    undefined,
    undefined,
    undefined,
    { conversationId: 'conversation-b' },
  );

  harness.sendSentinel('_close');
  const exitCode = await harness.waitForExit();
  assert.equal(exitCode, 0, harness.getStderr());

  const requestLog = harness.readRequestLog();
  const threadResumeLines = requestLog
    .split('\n')
    .filter((line) => line.startsWith('thread/resume '));
  assert.equal(harness.getRequestCount('initialize'), 1, requestLog);
  assert.equal(harness.getRequestCount('turn/start'), 4, requestLog);
  assert.deepEqual(
    threadResumeLines.map((line) => JSON.parse(line.slice('thread/resume '.length)).params.threadId),
    ['thread-a', 'thread-b', 'thread-a', 'thread-b'],
    'runner reuse must resume each conversation with its own persisted thread mapping',
  );
  assert.deepEqual(
    requestScopes.filter((entry) => entry.phase === 'get').map((entry) => entry.scope),
    [
      { conversationId: 'conversation-a' },
      { conversationId: 'conversation-b' },
      { conversationId: 'conversation-a' },
      { conversationId: 'conversation-b' },
    ],
    'runtime lookup stays keyed by the selected conversation identity while switching',
  );
  assert.deepEqual(
    turnStarts.map(({ prompt, sessionId, chatJid, replyRouteJid }) => ({
      prompt,
      sessionId,
      chatJid,
      replyRouteJid,
    })),
    [
      {
        prompt: '会话A首轮',
        sessionId: 'thread-a',
        chatJid: 'web:workspace-a',
        replyRouteJid: null,
      },
      {
        prompt: '会话B首轮',
        sessionId: 'thread-b',
        chatJid: 'web:workspace-a',
        replyRouteJid: null,
      },
      {
        prompt: '会话A恢复',
        sessionId: 'thread-a',
        chatJid: 'web:workspace-a',
        replyRouteJid: null,
      },
      {
        prompt: '会话B恢复',
        sessionId: 'thread-b',
        chatJid: 'web:workspace-a',
        replyRouteJid: null,
      },
    ],
    'initial runtime activations keep the persisted conversation thread selection before IPC follow-up retargeting applies',
  );
  console.log('✅ multi-conversation switching resume regression passed');
} finally {
  await harness.forceKillIfRunning();
}

const queuedContextHarness = await startPersistentRunnerHarness({
  initialPrompt: '初始会话A',
  initialChatJid: 'web:workspace-a',
  sessionId: 'thread-a',
  codexOptions: {
    repliesByText: {
      初始会话A: '初始会话A回复',
      '旧会话排队消息\n切换到会话B': '切换到会话B回复',
    },
  },
});

try {
  await queuedContextHarness.waitForOutput(
    (entry) =>
      entry.status === 'success' && entry.result === '初始会话A回复',
    'initial queued-context response',
  );

  queuedContextHarness.sendIpcMessage('010-stale-conversation-a.json', {
    text: '旧会话排队消息',
    sessionId: 'thread-a',
    chatJid: 'web:workspace-a',
    replyRouteJid: 'telegram:route-a',
  });
  queuedContextHarness.sendIpcMessage('011-target-conversation-b.json', {
    text: '切换到会话B',
    sessionId: 'thread-b',
    chatJid: 'web:workspace-b',
    replyRouteJid: 'telegram:route-b',
  });

  await queuedContextHarness.waitForOutput(
    (entry) =>
      entry.status === 'success' && entry.result === '切换到会话B回复',
    'queued context switch response',
  );

  queuedContextHarness.sendSentinel('_close');
  const queuedExitCode = await queuedContextHarness.waitForExit();
  assert.equal(queuedExitCode, 0, queuedContextHarness.getStderr());

  const queuedRequestLog = queuedContextHarness.readRequestLog();
  const queuedResumeLines = queuedRequestLog
    .split('\n')
    .filter((line) => line.startsWith('thread/resume '));
  const queuedResumeRequests = queuedResumeLines.map((line) =>
    JSON.parse(line.slice('thread/resume '.length)),
  );

  assert.equal(
    queuedResumeRequests.at(-1)?.params?.threadId,
    'thread-b',
    'runner wake-up after draining multiple queued messages must use the latest queued conversation context',
  );
} finally {
  await queuedContextHarness.forceKillIfRunning();
}

const activeTurnBoundaryHarness = await startPersistentRunnerHarness({
  initialPrompt: '活跃会话A',
  initialChatJid: 'web:workspace-a',
  sessionId: 'thread-a',
  codexOptions: {
    completionDelayMs: 600,
    repliesByText: {
      活跃会话A: '活跃会话A回复',
      切换到会话B: '切换到会话B回复',
    },
  },
});

try {
  await activeTurnBoundaryHarness.waitForRequest('turn/start');

  activeTurnBoundaryHarness.sendIpcMessage('020-active-turn-conversation-b.json', {
    text: '切换到会话B',
    sessionId: 'thread-b',
    chatJid: 'web:workspace-b',
    replyRouteJid: 'telegram:route-b',
  });

  try {
    await activeTurnBoundaryHarness.waitForOutput(
      (entry) =>
        entry.status === 'success' && entry.result === '活跃会话A回复',
      'active turn conversation-a response',
    );
    await activeTurnBoundaryHarness.waitForOutput(
      (entry) =>
        entry.status === 'success' && entry.result === '切换到会话B回复',
      'active turn conversation-b response',
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nOutputs:\n${JSON.stringify(
        activeTurnBoundaryHarness.outputs,
        null,
        2,
      )}\nSTDERR:\n${activeTurnBoundaryHarness.getStderr()}\nRequest log:\n${activeTurnBoundaryHarness.readRequestLog()}`,
    );
  }

  activeTurnBoundaryHarness.sendSentinel('_close');
  const activeTurnExitCode = await activeTurnBoundaryHarness.waitForExit();
  assert.equal(
    activeTurnExitCode,
    0,
    activeTurnBoundaryHarness.getStderr(),
  );

  const activeTurnRequestLog = activeTurnBoundaryHarness.readRequestLog();
  const activeTurnRequestLines = activeTurnRequestLog
    .split('\n')
    .filter(Boolean);
  const activeTurnResumeRequests = activeTurnRequestLines
    .filter((line) => line.startsWith('thread/resume '))
    .map((line) => JSON.parse(line.slice('thread/resume '.length)));
  const activeTurnSteerRequests = activeTurnRequestLines
    .filter((line) => line.startsWith('turn/steer '))
    .map((line) => JSON.parse(line.slice('turn/steer '.length)));
  const activeTurnStartRequests = activeTurnRequestLines.filter((line) =>
    line.startsWith('turn/start '),
  );

  assert.equal(
    activeTurnStartRequests.length,
    2,
    `metadata-changing follow-up must start a second turn after the active turn finishes\n${activeTurnRequestLog}`,
  );
  assert.equal(
    activeTurnResumeRequests.at(-1)?.params?.threadId,
    'thread-b',
    'the follow-up queued during an active turn must resume conversation B on the next turn',
  );
  assert.equal(
    activeTurnSteerRequests.length,
    0,
    `metadata-changing follow-up must not be sent through turn/steer while conversation A is still active\n${activeTurnRequestLog}`,
  );
} finally {
  await activeTurnBoundaryHarness.forceKillIfRunning();
}

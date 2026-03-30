#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-secondary-unrecoverable-'),
);

process.chdir(tempRoot);

const {
  initDatabase,
  closeDatabase,
  setRegisteredGroup,
  setSession,
  getRuntimeSession,
  getMessagesSince,
  ensureChatExists,
} = await import(path.join(repoRoot, 'dist', 'db.js'));
const {
  createAgentConversationRuntime,
} = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'chat-runtime',
    'agent-conversation-runtime.js',
  )
);
const {
  EMPTY_CURSOR,
} = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'recovery.js')
);
const { resolveRuntimeScopePaths } = await import(
  path.join(repoRoot, 'dist', 'features', 'execution', 'container-runner.js')
);
const { ensureAgentDirectories } = await import(
  path.join(repoRoot, 'dist', 'features', 'agents', 'agent-directories.js')
);

initDatabase();

setRegisteredGroup('web:workspace-a', {
  name: 'Workspace A',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  executionMode: 'container',
});

const agentId = 'agent-1';
ensureAgentDirectories('workspace-a', agentId);

const mainScope = resolveRuntimeScopePaths('workspace-a');
const agentScope = resolveRuntimeScopePaths('workspace-a', { agentId });
fs.mkdirSync(mainScope.codexHomeDir, { recursive: true });
fs.mkdirSync(agentScope.codexHomeDir, { recursive: true });
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'config.toml'), 'model = "gpt-5"');
fs.writeFileSync(path.join(mainScope.codexHomeDir, 'thread.json'), 'main-thread-file');
fs.writeFileSync(path.join(agentScope.codexHomeDir, 'config.toml'), 'model = "gpt-5"');
fs.writeFileSync(path.join(agentScope.codexHomeDir, 'thread.json'), 'agent-thread-file');

setSession('workspace-a', 'main-thread');
setSession('workspace-a', 'agent-thread', agentId);

const now = new Date().toISOString();
const {
  storeMessageDirect,
  createAgent,
} = await import(path.join(repoRoot, 'dist', 'db.js'));

createAgent({
  id: agentId,
  group_folder: 'workspace-a',
  chat_jid: 'web:workspace-a',
  name: 'Helper',
  prompt: 'Help',
  status: 'idle',
  kind: 'conversation',
  created_by: 'user-1',
  created_at: now,
});

ensureChatExists(`web:workspace-a#agent:${agentId}`);

storeMessageDirect(
  'msg-1',
  `web:workspace-a#agent:${agentId}`,
  'user-1',
  'User',
  'hello',
  now,
  false,
);

const lastAgentTimestamp = {};
const broadcasts = [];
const runtime = createAgentConversationRuntime({
  assistantName: 'HappyPaw',
  registeredGroups: {
    'web:workspace-a': {
      jid: 'web:workspace-a',
      name: 'Workspace A',
      folder: 'workspace-a',
      added_at: now,
      executionMode: 'container',
    },
  },
  lastAgentTimestamp,
  advanceCursors: (jid, candidate) => {
    lastAgentTimestamp[jid] = candidate;
  },
  formatMessages: (messages) => JSON.stringify(messages.map((m) => m.content)),
  collectMessageImages: () => [],
  queue: {
    closeStdin: () => {},
    registerProcess: () => {},
  },
  getIpcRuntime: () => ({
    watchGroup: () => {},
    unwatchGroup: () => {},
  }),
  getAvailableGroups: () => [],
  resolveEffectiveGroup: (group) => ({
    effectiveGroup: group,
    isHome: false,
  }),
  resolveOwnerHomeFolder: () => undefined,
  extractLocalImImagePaths: () => [],
  sendImWithRetry: async () => true,
  sendImWithFailTracking: () => {},
  writeUsageRecords: () => {},
  getAgentReplyRouteJid: () => undefined,
  getEffectiveRuntime: () => 'codex',
  sendSystemMessage: (jid, type, detail) => {
    broadcasts.push({ jid, type, detail });
  },
  broadcastStreamEvent: () => {},
  broadcastNewMessage: () => {},
  broadcastAgentStatus: () => {},
  imManager: {
    isChannelAvailableForJid: () => false,
    createStreamingSession: () => undefined,
  },
  getChannelType: () => null,
  runHostAgent: async () => ({
    status: 'error',
    result: null,
    error: 'unrecoverable_transcript: test secondary reset',
  }),
  runContainerAgent: async () => ({
    status: 'error',
    result: null,
    error: 'unrecoverable_transcript: test secondary reset',
  }),
  writeTasksSnapshot: () => {},
  writeGroupsSnapshot: () => {},
});
await runtime.processAgentConversation('web:workspace-a', agentId);

assert.deepEqual(getRuntimeSession('workspace-a'), {
  sessionId: 'main-thread',
});
assert.equal(getRuntimeSession('workspace-a', agentId), undefined);
assert.ok(
  fs.existsSync(path.join(mainScope.codexHomeDir, 'thread.json')),
  'secondary auto-reset must preserve workspace main runtime files',
);
assert.ok(
  !fs.existsSync(path.join(agentScope.codexHomeDir, 'thread.json')),
  'secondary auto-reset must clear only agent runtime files',
);
assert.equal(
  broadcasts.some(
    (entry) =>
      entry.jid === `web:workspace-a#agent:${agentId}` &&
      entry.type === 'context_reset' &&
      entry.detail.includes('test secondary reset'),
  ),
  true,
);
assert.notEqual(
  lastAgentTimestamp[`web:workspace-a#agent:${agentId}`],
  undefined,
  'secondary auto-reset should advance only the secondary cursor',
);
assert.deepEqual(getMessagesSince(`web:workspace-a#agent:${agentId}`, EMPTY_CURSOR)[0]?.content, 'hello');

closeDatabase();
console.log('✅ secondary unrecoverable transcript reset checks passed');

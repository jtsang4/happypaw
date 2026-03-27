#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

const { createIpcRuntime } = await import(
  pathToFileURL(path.join(repoRoot, 'dist', 'index-ipc-runtime.js')).href
);

const [indexSource, ipcRuntimeSource] = await Promise.all([
  fs.readFile(path.join(repoRoot, 'src', 'index.ts'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'src', 'index-ipc-runtime.ts'), 'utf8'),
]);

assert.match(
  ipcRuntimeSource,
  /export function createIpcRuntime/,
  'index-ipc-runtime.ts exports the extracted IPC runtime factory',
);
assert.doesNotMatch(
  indexSource,
  /function startIpcWatcher\(/,
  'src/index.ts no longer defines startIpcWatcher inline',
);
assert.doesNotMatch(
  indexSource,
  /async function processTaskIpc\(/,
  'src/index.ts no longer defines processTaskIpc inline',
);
assert.doesNotMatch(
  indexSource,
  /function canSendCrossGroupMessage\(/,
  'src/index.ts no longer defines the IPC cross-group guard inline',
);
assert.doesNotMatch(
  indexSource,
  /class IpcWatcherManager/,
  'src/index.ts no longer defines the IPC watcher manager inline',
);

const tempRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'happypaw-ipc-runtime-'),
);

const runtime = createIpcRuntime({
  dataDir: path.join(tempRoot, 'data'),
  groupsDir: path.join(tempRoot, 'groups'),
  mainGroupFolder: 'main',
  timezone: 'UTC',
  assistantName: 'HappyPaw',
  getRegisteredGroups: () => ({}),
  getShuttingDown: () => false,
  getActiveImReplyRoute: () => null,
  sendMessage: async () => undefined,
  ensureChatExists: () => {},
  storeMessageDirect: (msgId) => msgId,
  broadcastNewMessage: () => {},
  broadcastToWebClients: () => {},
  extractLocalImImagePaths: () => [],
  sendImWithFailTracking: () => {},
  retryImOperation: async (_label, _jid, fn) => {
    await fn();
    return true;
  },
  getChannelType: () => null,
  getGroupsByOwner: () => [],
  getConnectedChannelTypes: () => [],
  sendImage: async () => {},
  sendFile: async () => {},
  createTask: () => {},
  deleteTask: () => {},
  getAllTasks: () => [],
  getTaskById: () => undefined,
  updateTask: () => {},
  syncGroupMetadata: async () => {},
  getAvailableGroups: () => [],
  writeGroupsSnapshot: () => {},
  registerGroup: () => {},
  installSkillForUser: async () => ({ success: true }),
  deleteSkillForUser: () => ({ success: true }),
});

assert.equal(typeof runtime.startIpcWatcher, 'function');
assert.equal(typeof runtime.watchGroup, 'function');
assert.equal(typeof runtime.unwatchGroup, 'function');
assert.equal(typeof runtime.closeAll, 'function');

runtime.startIpcWatcher();
runtime.startIpcWatcher();
runtime.watchGroup('surface-test');
runtime.watchGroup('surface-test');
runtime.unwatchGroup('surface-test');
runtime.unwatchGroup('surface-test');
runtime.closeAll();

console.log('✅ IPC runtime module surface checks passed');

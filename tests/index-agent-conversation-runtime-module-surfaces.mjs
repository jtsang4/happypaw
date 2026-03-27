#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

const { createIndexAgentConversationRuntime } = await import(
  pathToFileURL(
    path.join(repoRoot, 'dist', 'index-agent-conversation-runtime.js'),
  ).href
);

const [indexSource, extractedSource] = await Promise.all([
  fs.readFile(path.join(repoRoot, 'src', 'index.ts'), 'utf8'),
  fs.readFile(
    path.join(repoRoot, 'src', 'index-agent-conversation-runtime.ts'),
    'utf8',
  ),
]);

assert.match(
  extractedSource,
  /export function createIndexAgentConversationRuntime/,
  'index-agent-conversation-runtime.ts exports the extracted conversation runtime factory',
);
assert.doesNotMatch(
  indexSource,
  /Recovered IM routing from persisted last_im_jid/,
  'src/index.ts no longer contains the agent IM route recovery implementation inline',
);
assert.doesNotMatch(
  indexSource,
  /Spawn result injected back to source chat/,
  'src/index.ts no longer contains spawn result injection inline',
);
assert.doesNotMatch(
  indexSource,
  /Agent streaming card session created for conversation agent/,
  'src/index.ts no longer contains agent streaming-card handling inline',
);

const runtime = createIndexAgentConversationRuntime({
  assistantName: 'HappyPaw',
  registeredGroups: {},
  lastAgentTimestamp: {},
  advanceCursors: () => {},
  formatMessages: () => '',
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
  resolveEffectiveGroup: (group) => ({ effectiveGroup: group, isHome: false }),
  resolveOwnerHomeFolder: () => undefined,
  extractLocalImImagePaths: () => [],
  sendImWithRetry: async () => true,
  sendImWithFailTracking: () => {},
  writeUsageRecords: () => {},
  getEffectiveRuntime: () => 'codex_app_server',
  sendSystemMessage: () => {},
  broadcastStreamEvent: () => {},
  broadcastNewMessage: () => {},
  broadcastAgentStatus: () => {},
  imManager: {
    isChannelAvailableForJid: () => false,
    createStreamingSession: () => undefined,
  },
  getChannelType: () => null,
});

assert.equal(typeof runtime.processAgentConversation, 'function');

console.log('✅ index agent conversation runtime module surface checks passed');
process.exit(0);

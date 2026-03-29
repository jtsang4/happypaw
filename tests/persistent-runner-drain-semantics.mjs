#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isPidAlive, startPersistentRunnerHarness } from './persistent-runner-test-helpers.mjs';

const harness = await startPersistentRunnerHarness({
  initialPrompt: '需要被 drain 的第一轮问题',
  codexOptions: {
    repliesByText: {
      '需要被 drain 的第一轮问题': 'drain 中完成当前回合',
    },
    completionDelayMs: 250,
  },
});

try {
  await harness.waitForRequest('turn/start');

  harness.sendIpcMessage('001-preserved-follow-up.json', { text: 'drain 后保留的追问' });
  harness.sendSentinel('_drain');

  await harness.waitForOutput(
    (entry) => entry.status === 'success' && entry.result === 'drain 中完成当前回合',
    'the active turn to complete under drain',
  );

  const exitCode = await harness.waitForExit();
  const requestLog = harness.readRequestLog();
  const preservedFollowUpPath = path.join(
    harness.ipcInputDir,
    '001-preserved-follow-up.json',
  );

  assert.equal(exitCode, 0, harness.getStderr());
  assert.equal(harness.getRequestCount('initialize'), 1, requestLog);
  assert.equal(harness.getRequestCount('turn/start'), 1, requestLog);
  assert.ok(
    fs.existsSync(preservedFollowUpPath),
    'queued follow-up work should remain on disk for later processing after drain',
  );
  assert.equal(harness.getSpawnPids().length, 1, harness.readChildLog());
  assert.equal(isPidAlive(harness.getLatestSpawnPid()), false);

  console.log('persistent runner drain semantics regression passed');
} finally {
  await harness.forceKillIfRunning();
}

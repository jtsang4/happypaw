#!/usr/bin/env node

import assert from 'node:assert/strict';

import { isPidAlive, startPersistentRunnerHarness } from './persistent-runner-test-helpers.mjs';

const harness = await startPersistentRunnerHarness({
  initialPrompt: '第一轮问题',
  codexOptions: {
    repliesByText: {
      第一轮问题: '第一轮回复',
      第二轮问题: '第二轮回复',
    },
  },
});

try {
  await harness.waitForOutput(
    (entry) => entry.status === 'success' && entry.result === '第一轮回复',
    'the first turn to finish',
  );

  harness.sendIpcMessage('001-second-turn.json', { text: '第二轮问题' });

  await harness.waitForOutput(
    (entry) => entry.status === 'success' && entry.result === '第二轮回复',
    'the second turn to finish',
  );

  harness.sendSentinel('_close');
  const exitCode = await harness.waitForExit();

  const requestLog = harness.readRequestLog();
  assert.equal(exitCode, 0, harness.getStderr());
  assert.equal(harness.getRequestCount('initialize'), 1, requestLog);
  assert.equal(harness.getRequestCount('turn/start'), 2, requestLog);
  assert.equal(harness.getSpawnPids().length, 1, harness.readChildLog());

  const spawnedPid = harness.getLatestSpawnPid();
  assert.ok(spawnedPid, 'expected one fake app-server child pid');
  assert.equal(
    isPidAlive(spawnedPid),
    false,
    `app-server child ${spawnedPid} should be gone after runner close`,
  );

  console.log('persistent runner app-server lifecycle regression passed');
} finally {
  await harness.forceKillIfRunning();
}

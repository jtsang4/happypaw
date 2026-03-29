#!/usr/bin/env node

import assert from 'node:assert/strict';

import { isPidAlive, startPersistentRunnerHarness } from './persistent-runner-test-helpers.mjs';

const harness = await startPersistentRunnerHarness({
  initialPrompt: '等待 close 的问题',
  codexOptions: {
    holdOpenTexts: ['等待 close 的问题'],
  },
});

try {
  await harness.waitForRequest('turn/start');
  harness.sendSentinel('_close');

  await harness.waitForOutput(
    (entry) => entry.status === 'closed',
    'the runner to emit a closed marker after close',
  );

  const exitCode = await harness.waitForExit();
  const requestLog = harness.readRequestLog();
  const spawnedPid = harness.getLatestSpawnPid();

  assert.equal(exitCode, 0, harness.getStderr());
  assert.equal(harness.getRequestCount('initialize'), 1, requestLog);
  assert.equal(harness.getRequestCount('turn/interrupt'), 1, requestLog);
  assert.ok(spawnedPid, 'expected a spawned app-server pid');
  assert.equal(isPidAlive(spawnedPid), false);

  console.log('persistent runner close cleanup regression passed');
} finally {
  await harness.forceKillIfRunning();
}

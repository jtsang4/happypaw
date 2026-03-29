#!/usr/bin/env node

import assert from 'node:assert/strict';

import { isPidAlive, startPersistentRunnerHarness, waitFor } from './persistent-runner-test-helpers.mjs';

const harness = await startPersistentRunnerHarness({
  initialPrompt: '第一轮问题',
  codexOptions: {
    repliesByText: {
      第一轮问题: '第一轮空闲前回复',
      空闲后第二轮问题: '空闲后继续复用',
    },
  },
});

try {
  await harness.waitForOutput(
    (entry) => entry.status === 'success' && entry.result === '第一轮空闲前回复',
    'the initial turn to finish',
  );

  await waitFor(
    () => harness.readRequestLog().includes('turn/start '),
    2_000,
    'the first turn/start to be recorded',
  );

  const pidBeforeIdle = harness.getLatestSpawnPid();
  await new Promise((resolve) => setTimeout(resolve, 300));

  harness.sendIpcMessage('001-idle-follow-up.json', { text: '空闲后第二轮问题' });

  await harness.waitForOutput(
    (entry) => entry.status === 'success' && entry.result === '空闲后继续复用',
    'the idle follow-up turn to finish',
  );

  harness.sendSentinel('_close');
  const exitCode = await harness.waitForExit();

  const requestLog = harness.readRequestLog();
  assert.equal(exitCode, 0, harness.getStderr());
  assert.equal(harness.getRequestCount('initialize'), 1, requestLog);
  assert.equal(harness.getRequestCount('turn/start'), 2, requestLog);
  assert.equal(harness.getSpawnPids().length, 1, harness.readChildLog());
  assert.equal(harness.getLatestSpawnPid(), pidBeforeIdle);
  assert.equal(isPidAlive(pidBeforeIdle), false);

  console.log('persistent runner idle reuse regression passed');
} finally {
  await harness.forceKillIfRunning();
}

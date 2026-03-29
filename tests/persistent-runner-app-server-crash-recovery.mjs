#!/usr/bin/env node

import assert from 'node:assert/strict';

import { startPersistentRunnerHarness } from './persistent-runner-test-helpers.mjs';

const harness = await startPersistentRunnerHarness({
  initialPrompt: '触发 app-server 崩溃',
  codexOptions: {
    crashDuringTurnTexts: ['触发 app-server 崩溃'],
    repliesByText: {
      崩溃恢复后的下一轮: '恢复后仍可继续',
    },
  },
});

try {
  await harness.waitForRequest('turn/start');
  const firstExitCode = await harness.waitForExit();
  const firstRequestLog = harness.readRequestLog();

  assert.notEqual(firstExitCode, 0, 'runner should fail when the persistent app-server dies unexpectedly');
  assert.match(
    harness.getStderr(),
    /codex app-server exited/u,
    `stderr should surface the app-server death\n${harness.getStderr()}`,
  );
  assert.equal(harness.getRequestCount('initialize'), 1, firstRequestLog);

  const recoveryHarness = await startPersistentRunnerHarness({
    initialPrompt: '崩溃恢复后的下一轮',
    sessionId: 'thr_persistent_runner',
    codexOptions: {
      threadId: 'thr_persistent_runner',
      repliesByText: {
        崩溃恢复后的下一轮: '恢复后仍可继续',
      },
    },
  });

  try {
    await recoveryHarness.waitForOutput(
      (entry) => entry.status === 'success' && entry.result === '恢复后仍可继续',
      'the recovery follow-up to succeed',
    );
    recoveryHarness.sendSentinel('_close');
    const recoveryExitCode = await recoveryHarness.waitForExit();
    const recoveryRequestLog = recoveryHarness.readRequestLog();

    assert.equal(recoveryExitCode, 0, recoveryHarness.getStderr());
    assert.equal(recoveryHarness.getRequestCount('initialize'), 1, recoveryRequestLog);
    assert.ok(
      recoveryRequestLog.includes('thread/resume '),
      recoveryRequestLog,
    );
  } finally {
    await recoveryHarness.forceKillIfRunning();
  }

  console.log('persistent runner app-server crash recovery regression passed');
} finally {
  await harness.forceKillIfRunning();
}

#!/usr/bin/env node

import assert from 'node:assert/strict';

import { isPidAlive, startPersistentRunnerHarness } from './persistent-runner-test-helpers.mjs';

async function runCloseScenario(label, codexOptions) {
  const harness = await startPersistentRunnerHarness({
    initialPrompt: `等待 close 的问题: ${label}`,
    codexOptions: {
      holdOpenTexts: [`等待 close 的问题: ${label}`],
      ...codexOptions,
    },
  });

  try {
    await harness.waitForRequest('turn/start');
    harness.sendSentinel('_close');

    await harness.waitForOutput(
      (entry) => entry.status === 'closed',
      `the runner to emit a closed marker after close (${label})`,
    );

    const exitCode = await harness.waitForExit();
    const requestLog = harness.readRequestLog();
    const spawnedPid = harness.getLatestSpawnPid();

    assert.equal(exitCode, 0, harness.getStderr());
    assert.equal(harness.getRequestCount('initialize'), 1, requestLog);
    assert.equal(harness.getRequestCount('turn/interrupt'), 1, requestLog);
    assert.ok(spawnedPid, `expected a spawned app-server pid (${label})`);
    assert.equal(isPidAlive(spawnedPid), false, `expected no live child after close (${label})`);
  } finally {
    await harness.forceKillIfRunning();
  }
}

await runCloseScenario('cooperative child', {});
await runCloseScenario('delayed child', { sigtermExitDelayMs: 1500 });
await runCloseScenario('stubborn child', { ignoreSigterm: true });

console.log('persistent runner close cleanup regression passed');

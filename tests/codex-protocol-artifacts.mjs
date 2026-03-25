#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'node',
  ['scripts/generate-codex-protocol-artifacts.mjs', '--check'],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) {
  console.error('❌ Codex protocol artifact drift detected.');
  process.exit(result.status ?? 1);
}

console.log('✅ Codex protocol artifacts match installed Codex CLI output.');

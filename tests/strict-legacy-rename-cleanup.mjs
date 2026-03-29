#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const forbiddenPattern = 'legacy-product|HAPPYCLAW_|mcp__happyclaw__|happyclaw-agent';

const result = spawnSync(
  'rg',
  [
    '-n',
    '--hidden',
    forbiddenPattern,
    '.',
    '--glob',
    '!.factory/**',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
    '--glob',
    '!dist/**',
    '--glob',
    '!generated/**',
    '--glob',
    '!README.md',
    '--glob',
    '!web/src/components/settings/AboutSection.tsx',
    '--glob',
    '!tests/strict-legacy-rename-cleanup.mjs',
  ],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status === 1) {
  console.log('✅ No forbidden legacy compatibility markers were found.');
  process.exit(0);
}

if (result.status === 0) {
  console.error('❌ Forbidden legacy compatibility markers remain in source or tests.');
  process.exit(1);
}

console.error(`❌ Search failed with exit code ${result.status ?? 'unknown'}.`);
process.exit(result.status ?? 1);

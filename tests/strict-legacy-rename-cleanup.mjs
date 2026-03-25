#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const legacyPascal = ['Happy', 'Claw'].join('');
const legacyLower = legacyPascal.toLowerCase();
const allowedDoc = ['docs/', 'happy', 'claw', '-codex-app-server-migration.md'].join('');
const pattern = [legacyPascal, legacyLower].join('|');

const result = spawnSync(
  'rg',
  [
    '-n',
    pattern,
    '.',
    '--glob',
    '!.factory/**',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
    '--glob',
    `!${allowedDoc}`,
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
  console.log('✅ No forbidden legacy product strings were found outside the allowed paths.');
  process.exit(0);
}

if (result.status === 0) {
  console.error('❌ Forbidden legacy product strings remain outside the allowed paths.');
  process.exit(1);
}

console.error(`❌ Search failed with exit code ${result.status ?? 'unknown'}.`);
process.exit(result.status ?? 1);

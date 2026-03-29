#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-runtime-config-key-'),
);

process.chdir(tempRoot);

const cryptoModule = await import(
  path.join(repoRoot, 'dist', 'runtime-config', 'crypto.js')
);

const initialKey = cryptoModule.getOrCreateEncryptionKey();
assert.equal(initialKey.length, 32, 'new runtime key should be 32 bytes');

const keyringPath = path.join(
  tempRoot,
  'data',
  'config',
  'runtime-config.keys.json',
);
const keyring = JSON.parse(fs.readFileSync(keyringPath, 'utf8'));
assert.equal(keyring.version, 1);
assert.equal(keyring.activeKeyId, 'main');
assert.match(keyring.keys.main, /^[0-9a-f]{64}$/);

const secondKey = cryptoModule.getOrCreateEncryptionKey();
assert.equal(
  secondKey.toString('hex'),
  initialKey.toString('hex'),
  'runtime keyring should be stable across repeated reads',
);

console.log('✅ runtime config keyring checks passed');

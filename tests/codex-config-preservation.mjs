#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happypaw-codex-config-'));

process.chdir(tempRoot);
process.env.OPENAI_BASE_URL = 'https://env.example.com/v1';
process.env.OPENAI_API_KEY = 'env-api-key';
process.env.OPENAI_MODEL = 'env-model';

const runtimeConfigModule = await import(
  path.join(repoRoot, 'dist', 'runtime-config.js')
);

const {
  getCodexProviderConfigWithSource,
  saveCodexProviderConfig,
  saveCodexProviderSecrets,
} = runtimeConfigModule;

function readStoredCodexPayload() {
  const configFile = path.join(tempRoot, 'data', 'config', 'codex-provider.json');
  if (!fs.existsSync(configFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}

const initial = getCodexProviderConfigWithSource();
assert.equal(initial.source, 'env', 'initial Codex config falls back to env');
assert.equal(initial.config.openaiBaseUrl, 'https://env.example.com/v1');
assert.equal(initial.config.openaiApiKey, 'env-api-key');
assert.equal(initial.config.openaiModel, 'env-model');

const afterModelOnly = saveCodexProviderConfig({
  openaiModel: 'runtime-model',
});
assert.equal(afterModelOnly.openaiModel, 'runtime-model');
assert.equal(
  afterModelOnly.openaiBaseUrl,
  'https://env.example.com/v1',
  'omitted base URL still resolves from env fallback',
);
assert.equal(
  afterModelOnly.openaiApiKey,
  'env-api-key',
  'omitted env-backed API key remains effective',
);
let stored = readStoredCodexPayload();
assert.ok(stored, 'runtime save creates a stored codex config file');
assert.equal(
  stored.openaiBaseUrl,
  '',
  'env-backed base URL is not destructively persisted into runtime file',
);
assert.equal(stored.openaiModel, 'runtime-model');

const afterBaseUrlOnly = saveCodexProviderConfig({
  openaiBaseUrl: 'https://runtime.example.com/v1',
});
assert.equal(
  afterBaseUrlOnly.openaiBaseUrl,
  'https://runtime.example.com/v1',
  'explicit base URL update is applied',
);
assert.equal(
  afterBaseUrlOnly.openaiModel,
  'runtime-model',
  'omitted model preserves the existing runtime value',
);
assert.equal(afterBaseUrlOnly.openaiApiKey, 'env-api-key');

const afterEmptyUpdate = saveCodexProviderConfig({
  openaiBaseUrl: '',
});
assert.equal(
  afterEmptyUpdate.openaiBaseUrl,
  'https://env.example.com/v1',
  'empty base URL input clears the runtime override and falls back to env/default behavior',
);
assert.equal(afterEmptyUpdate.openaiModel, 'runtime-model');

const afterSecretUpdate = saveCodexProviderSecrets({
  openaiApiKey: 'runtime-api-key',
});
assert.equal(afterSecretUpdate.openaiApiKey, 'runtime-api-key');
assert.equal(
  afterSecretUpdate.openaiBaseUrl,
  'https://env.example.com/v1',
  'secret updates should preserve the cleared base URL override and keep env/default fallback behavior',
);
assert.equal(afterSecretUpdate.openaiModel, 'runtime-model');

const afterSecretClear = saveCodexProviderSecrets({
  clearOpenaiApiKey: true,
});
assert.equal(
  afterSecretClear.openaiApiKey,
  'env-api-key',
  'clearing runtime secret falls back to env-backed API key',
);
assert.equal(
  afterSecretClear.openaiBaseUrl,
  'https://env.example.com/v1',
  'clearing runtime secret should not restore a previously cleared base URL override',
);
assert.equal(afterSecretClear.openaiModel, 'runtime-model');

stored = readStoredCodexPayload();
assert.ok(stored, 'runtime config file remains after partial secret clear');
assert.equal(
  stored.openaiBaseUrl,
  '',
  'cleared runtime base URL should not remain persisted in the stored config file',
);
assert.equal(stored.openaiModel, 'runtime-model');

const reloaded = getCodexProviderConfigWithSource();
assert.equal(reloaded.source, 'runtime', 'runtime source stays selected when overrides exist');
assert.equal(
  reloaded.config.openaiBaseUrl,
  'https://env.example.com/v1',
  'reloaded config resolves base URL from env/default once the runtime override is cleared',
);
assert.equal(
  reloaded.config.openaiApiKey,
  'env-api-key',
  'effective config still resolves API key from env after runtime secret clear',
);
assert.equal(reloaded.config.openaiModel, 'runtime-model');

console.log('✅ codex config preservation checks passed');

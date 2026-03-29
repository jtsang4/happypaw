#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

const result = spawnSync(
  'node',
  ['scripts/generate-codex-protocol-artifacts.mjs', '--check'],
  {
    cwd: repoRoot,
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

const syncScriptSource = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'sync-stream-event.sh'),
  'utf8',
);
assert.match(
  syncScriptSource,
  /generated\/codex-app-server-protocol\/ts/u,
  'make sync-types should sync the generated Codex protocol TypeScript artifacts into the agent-runner source tree',
);

const codexClientSource = fs.readFileSync(
  path.join(repoRoot, 'container', 'agent-runner', 'src', 'codex-client.ts'),
  'utf8',
);
assert.match(
  codexClientSource,
  /generated\/codex-app-server-protocol\/index\.js/u,
  'codex-client.ts should import App Server wire types from the generated protocol artifacts',
);
assert.doesNotMatch(
  codexClientSource,
  /export interface CodexJsonRpcNotification/u,
  'codex-client.ts should not keep a handwritten notification wire contract',
);
assert.doesNotMatch(
  codexClientSource,
  /export interface CodexJsonRpcRequest/u,
  'codex-client.ts should not keep a handwritten request wire contract',
);

const codexRuntimeSource = fs.readFileSync(
  path.join(repoRoot, 'container', 'agent-runner', 'src', 'codex-runtime.ts'),
  'utf8',
);
assert.doesNotMatch(
  codexRuntimeSource,
  /as\s+\{\s*thread\?:\s*\{\s*id\?:\s*string/u,
  'codex-runtime.ts should not cast thread responses to handwritten partial shapes',
);
assert.doesNotMatch(
  codexRuntimeSource,
  /as\s+\{\s*data\?:\s*unknown\[\]\s*;\s*nextCursor\?:\s*string\s*\|\s*null/u,
  'codex-runtime.ts should not cast MCP status responses to handwritten transport shapes',
);

console.log('✅ Codex protocol artifacts match installed Codex CLI output.');

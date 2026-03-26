#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const agentRunnerDist = path.join(repoRoot, 'container', 'agent-runner', 'dist');

function makeFakeCodexScript(scriptPath, requestLogPath) {
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const requestLogPath = ${JSON.stringify(requestLogPath)};
let buffer = '';
function log(line) { fs.appendFileSync(requestLogPath, line + '\\n'); }
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
const freshThreadId = 'thr_fresh';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    log(msg.method || 'response');
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { userAgent: 'fake-codex', platformFamily: 'unix', platformOs: 'linux' } });
      continue;
    }
    if (msg.method === 'initialized') {
      continue;
    }
    if (msg.method === 'thread/start') {
      send({ id: msg.id, result: { thread: { id: freshThreadId } } });
      send({ method: 'thread/started', params: { thread: { id: freshThreadId } } });
      continue;
    }
    if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      continue;
    }
    if (msg.method === 'turn/start') {
      const turnId = 'turn_bootstrap';
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: turnId } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_msg', delta: '你好，Codex' } });
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: msg.params.threadId,
          turnId,
          tokenUsage: {
            total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0 },
            last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0 },
            modelContextWindow: null
          }
        }
      });
      send({
        method: 'turn/completed',
        params: {
          threadId: msg.params.threadId,
          turn: {
            id: turnId,
            status: 'completed',
            items: [
              { type: 'agentMessage', id: 'item_msg', text: '你好，Codex', phase: 'final_answer', memoryCitation: null }
            ],
            error: null
          }
        }
      });
      continue;
    }
    if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      send({
        method: 'turn/completed',
        params: {
          threadId: msg.params.threadId,
          turn: { id: msg.params.turnId, status: 'interrupted', items: [], error: null }
        }
      });
      continue;
    }
  }
});
`,
    'utf8',
  );
  fs.chmodSync(scriptPath, 0o755);
}

async function runScenario(name, sessionId) {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `happypaw-codex-runtime-${name}-`),
  );
  const binDir = path.join(tempRoot, 'bin');
  const groupDir = path.join(tempRoot, 'group');
  const globalDir = path.join(tempRoot, 'global');
  const memoryDir = path.join(tempRoot, 'memory');
  const ipcInputDir = path.join(tempRoot, 'ipc', 'input');
  const homeDir = path.join(tempRoot, 'home');
  const codeHome = path.join(tempRoot, '.codex');
  const requestLogPath = path.join(tempRoot, 'requests.log');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(ipcInputDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(codeHome, { recursive: true });

  const fakeCodex = path.join(binDir, 'codex');
  makeFakeCodexScript(fakeCodex, requestLogPath);

  const outputs = [];
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.HOME = homeDir;
  process.env.CODEX_HOME = codeHome;
  process.env.HAPPYPAW_WORKSPACE_GROUP = groupDir;
  process.env.HAPPYPAW_WORKSPACE_GLOBAL = globalDir;
  process.env.HAPPYPAW_WORKSPACE_MEMORY = memoryDir;
  process.env.HAPPYPAW_WORKSPACE_IPC = path.join(tempRoot, 'ipc');

  const { runCodexRuntime } = await import(
    path.join(agentRunnerDist, 'codex-runtime.js')
  );

  const result = await runCodexRuntime({
    prompt: '请回答一句问候',
    sessionId,
    containerInput: {
      prompt: '请回答一句问候',
      sessionId,
      runtime: 'codex_app_server',
      groupFolder: 'demo',
      chatJid: 'web:demo',
      isMain: false,
      isHome: false,
      isAdminHome: false,
      turnId: 'turn-from-host',
    },
    memoryRecall: 'memory recall prompt',
    deps: {
      WORKSPACE_GLOBAL: globalDir,
      WORKSPACE_GROUP: groupDir,
      WORKSPACE_MEMORY: memoryDir,
      SECURITY_RULES: 'security rules',
      log: () => {},
      writeOutput: (output) => outputs.push(output),
      shouldInterrupt: () => false,
      shouldClose: () => false,
      normalizeHomeFlags: (input) => ({
        isHome: Boolean(input.isHome),
        isAdminHome: Boolean(input.isAdminHome),
      }),
      buildChannelGuidelines: () => '',
      truncateWithHeadTail: (content) => content,
      generateTurnId: () => 'generated-turn-id',
    },
    detectImageMimeTypeFromBase64Strict: () => undefined,
  });

  const requestOrder = fs
    .readFileSync(requestLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);

  return { outputs, requestOrder, result };
}

const fresh = await runScenario('fresh', undefined);
assert.deepEqual(fresh.requestOrder.slice(0, 4), [
  'initialize',
  'initialized',
  'thread/start',
  'turn/start',
]);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'success' &&
      entry.result === '你好，Codex' &&
      entry.newSessionId === 'thr_fresh',
  ),
  'fresh thread run emits final success with thread id persisted as newSessionId',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'text_delta' &&
      entry.streamEvent?.text === '你好，Codex',
  ),
  JSON.stringify(fresh.outputs, null, 2),
);
assert.equal(fresh.result.newSessionId, 'thr_fresh');
assert.equal(fresh.result.interruptedDuringQuery, false);

const resumed = await runScenario('resume', 'thr_saved');
assert.deepEqual(resumed.requestOrder.slice(0, 4), [
  'initialize',
  'initialized',
  'thread/resume',
  'turn/start',
]);
assert.ok(
  resumed.outputs.some(
    (entry) =>
      entry.status === 'success' &&
      entry.result === '你好，Codex' &&
      entry.newSessionId === 'thr_saved',
  ),
  'resumed run keeps persisted HappyPaw session mapped to the resumed Codex thread id',
);
assert.equal(resumed.result.newSessionId, 'thr_saved');

console.log('✅ codex runtime bootstrap checks passed');

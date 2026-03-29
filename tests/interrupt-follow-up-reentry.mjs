import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const OUTPUT_START_MARKER = '---HAPPYPAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYPAW_OUTPUT_END---';

function makeFakeCodexScript(scriptPath, requestLogPath) {
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const requestLogPath = ${JSON.stringify(requestLogPath)};
const requiredBridgeTools = ${JSON.stringify([
  'cancel_task',
  'get_context',
  'list_tasks',
  'memory_append',
  'memory_get',
  'memory_search',
  'pause_task',
  'resume_task',
  'schedule_task',
  'send_file',
  'send_image',
  'send_message',
])};
let buffer = '';
let activeTurn = null;

function log(line) {
  fs.appendFileSync(requestLogPath, line + '\\n');
}

function send(message) {
  log('notify ' + JSON.stringify(message));
  process.stdout.write(JSON.stringify(message) + '\\n');
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    log(msg.method ? msg.method + ' ' + JSON.stringify(msg) : 'response ' + JSON.stringify(msg));

    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { userAgent: 'fake-codex', platformFamily: 'unix', platformOs: 'linux' } });
      continue;
    }
    if (msg.method === 'initialized') {
      continue;
    }
    if (msg.method === 'mcpServerStatus/list') {
      send({
        id: msg.id,
        result: {
          data: [
            {
              name: 'happypaw',
              authStatus: 'bearerToken',
              tools: Object.fromEntries(
                requiredBridgeTools.map((toolName) => [
                  toolName,
                  { name: toolName, inputSchema: {} },
                ]),
              ),
              resources: [],
              resourceTemplates: [],
            },
          ],
          nextCursor: null,
        },
      });
      continue;
    }
    if (msg.method === 'thread/start') {
      send({ id: msg.id, result: { thread: { id: 'thr_interrupt_reentry' } } });
      continue;
    }
    if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      continue;
    }
    if (msg.method === 'turn/start') {
      const turnId = 'turn_' + Date.now();
      const textInput = Array.isArray(msg.params.input)
        ? msg.params.input.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\\n')
        : '';
      activeTurn = { threadId: msg.params.threadId, turnId, textInput };
      send({ id: msg.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        send({ method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: turnId } } });
        if (textInput === '第一轮问题') {
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: msg.params.threadId,
              turnId,
              itemId: 'item_msg',
              delta: '第一轮中断前输出',
            },
          });
          return;
        }
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: msg.params.threadId,
            turnId,
            itemId: 'item_msg',
            delta: '已立即继续: ' + textInput,
          },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId: msg.params.threadId,
            turn: {
              id: turnId,
              status: 'completed',
              items: [
                {
                  type: 'agentMessage',
                  id: 'item_msg',
                  text: '已立即继续: ' + textInput,
                  phase: 'final_answer',
                  memoryCitation: null,
                },
              ],
              error: null,
            },
          },
        });
        activeTurn = null;
      }, 0);
      continue;
    }
    if (msg.method === 'turn/steer') {
      send({ id: msg.id, error: { code: -32002, message: 'steer temporarily unavailable after interrupt prep' } });
      continue;
    }
    if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      if (activeTurn) {
        send({
          method: 'turn/completed',
          params: {
            threadId: activeTurn.threadId,
            turn: {
              id: activeTurn.turnId,
              status: 'interrupted',
              items: [],
              error: null,
            },
          },
        });
        activeTurn = null;
      }
    }
  }
});
`,
    'utf8',
  );
  fs.chmodSync(scriptPath, 0o755);
}

function writeJsonAtomically(filePath, payload) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tempPath, filePath);
}

async function waitFor(predicate, timeoutMs, description) {
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-interrupt-reentry-'),
);
const binDir = path.join(tempRoot, 'bin');
const groupDir = path.join(tempRoot, 'group');
const globalDir = path.join(tempRoot, 'global');
const memoryDir = path.join(tempRoot, 'memory');
const ipcInputDir = path.join(tempRoot, 'ipc', 'input');
const homeDir = path.join(tempRoot, 'home');
const codexHome = path.join(tempRoot, '.codex');
const requestLogPath = path.join(tempRoot, 'requests.log');

fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(groupDir, { recursive: true });
fs.mkdirSync(globalDir, { recursive: true });
fs.mkdirSync(memoryDir, { recursive: true });
fs.mkdirSync(ipcInputDir, { recursive: true });
fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });

const fakeCodexPath = path.join(binDir, 'codex');
makeFakeCodexScript(fakeCodexPath, requestLogPath);

const outputs = [];
let stdoutBuffer = '';
let stderrBuffer = '';
let markerOpen = false;
let markerJson = '';

const child = spawn(
  'npx',
  ['tsx', path.join(repoRoot, 'container/agent-runner/src/index.ts')],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: homeDir,
      CODEX_HOME: codexHome,
      HAPPYPAW_CODEX_EXECUTABLE: fakeCodexPath,
      HAPPYPAW_WORKSPACE_GROUP: groupDir,
      HAPPYPAW_WORKSPACE_GLOBAL: globalDir,
      HAPPYPAW_WORKSPACE_MEMORY: memoryDir,
      HAPPYPAW_WORKSPACE_IPC: path.join(tempRoot, 'ipc'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
    const rawLine = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    const line = rawLine.replace(/\r$/, '');
    if (line === OUTPUT_START_MARKER) {
      markerOpen = true;
      markerJson = '';
      continue;
    }
    if (line === OUTPUT_END_MARKER) {
      if (markerOpen) {
        outputs.push(JSON.parse(markerJson));
      }
      markerOpen = false;
      markerJson = '';
      continue;
    }
    if (markerOpen) {
      markerJson += line;
    }
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrBuffer += chunk;
});

child.stdin.end(
  JSON.stringify({
    prompt: '第一轮问题',
    runtime: 'codex_app_server',
    groupFolder: 'demo',
    chatJid: 'web:demo',
    turnId: 'host-turn-1',
    isHome: false,
    isAdminHome: false,
  }),
);

await waitFor(
  () =>
    fs.existsSync(requestLogPath) &&
    fs.readFileSync(requestLogPath, 'utf8').includes('turn/start'),
  10_000,
  'the initial Codex turn to start',
);

writeJsonAtomically(path.join(ipcInputDir, '001-follow-up.json'), {
  type: 'message',
  text: '中断后应立即继续处理这条追问',
});

await waitFor(
  () => fs.readFileSync(requestLogPath, 'utf8').includes('turn/steer'),
  10_000,
  'the deferred follow-up to be offered as turn/steer',
);

fs.writeFileSync(path.join(ipcInputDir, '_interrupt'), '');

try {
  await waitFor(
    () =>
      outputs.some(
        (entry) =>
          entry.status === 'success' &&
          entry.result === '已立即继续: 中断后应立即继续处理这条追问',
      ),
    10_000,
    'the deferred follow-up to be re-entered immediately after interrupt',
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\nOutputs:\n${JSON.stringify(outputs, null, 2)}\nSTDERR:\n${stderrBuffer}\nRequest log:\n${fs.readFileSync(requestLogPath, 'utf8')}`,
  );
}

fs.writeFileSync(path.join(ipcInputDir, '_close'), '');

const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(
      new Error(
        `agent-runner did not exit in time\nSTDERR:\n${stderrBuffer}\nSTDOUT:\n${stdoutBuffer}`,
      ),
    );
  }, 10_000);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (signal) {
      reject(new Error(`agent-runner exited via signal ${signal}\nSTDERR:\n${stderrBuffer}`));
      return;
    }
    resolve(code);
  });
});

const requestLog = fs.readFileSync(requestLogPath, 'utf8');
const turnStartCount = requestLog
  .split('\n')
  .filter((line) => line.startsWith('turn/start '))
  .length;

assert.equal(exitCode, 0, `agent-runner exited successfully\nSTDERR:\n${stderrBuffer}`);
assert.equal(turnStartCount, 2, requestLog);
assert.ok(
  outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'status' &&
      entry.streamEvent?.statusText === 'interrupted',
  ),
  JSON.stringify(outputs, null, 2),
);
assert.ok(
  outputs.some(
    (entry) =>
      entry.status === 'success' &&
      entry.result === '已立即继续: 中断后应立即继续处理这条追问',
  ),
  JSON.stringify(outputs, null, 2),
);
assert.ok(
  requestLog.includes('turn/steer'),
  'the active-turn follow-up first attempted turn/steer before being deferred',
);

console.log('interrupt follow-up reentry regression passed');

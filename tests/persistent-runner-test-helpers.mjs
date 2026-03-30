import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
export const OUTPUT_START_MARKER = '---HAPPYPAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---HAPPYPAW_OUTPUT_END---';

function makeFakeCodexScript(scriptPath, requestLogPath, childLogPath, options = {}) {
  const threadId = options.threadId ?? 'thr_persistent_runner';
  const defaultReplyPrefix = options.defaultReplyPrefix ?? '回复: ';
  const repliesByText = options.repliesByText ?? {};
  const holdOpenTexts = options.holdOpenTexts ?? [];
  const crashDuringTurnTexts = options.crashDuringTurnTexts ?? [];
  const completionDelayMs = options.completionDelayMs ?? 0;

  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const requestLogPath = ${JSON.stringify(requestLogPath)};
const childLogPath = ${JSON.stringify(childLogPath)};
const threadId = ${JSON.stringify(threadId)};
const defaultReplyPrefix = ${JSON.stringify(defaultReplyPrefix)};
const repliesByText = ${JSON.stringify(repliesByText)};
const holdOpenTexts = new Set(${JSON.stringify(holdOpenTexts)});
const crashDuringTurnTexts = new Set(${JSON.stringify(crashDuringTurnTexts)});
const completionDelayMs = ${JSON.stringify(completionDelayMs)};
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

function append(filePath, line) {
  fs.appendFileSync(filePath, line + '\\n');
}

function logRequest(line) {
  append(requestLogPath, line);
}

function logChild(line) {
  append(childLogPath, line);
}

function send(message) {
  logRequest('notify ' + JSON.stringify(message));
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function completeTurn(turn, status, text) {
  if (!turn || !activeTurn || activeTurn.turnId !== turn.turnId) return;
  if (typeof text === 'string' && text.length > 0) {
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        itemId: 'item_msg',
        delta: text,
      },
    });
  }
  send({
    method: 'turn/completed',
    params: {
      threadId: turn.threadId,
      turn: {
        id: turn.turnId,
        status,
        items:
          status === 'completed'
            ? [
                {
                  type: 'agentMessage',
                  id: 'item_msg',
                  text,
                  phase: 'final_answer',
                  memoryCitation: null,
                },
              ]
            : [],
        error: null,
      },
    },
  });
  activeTurn = null;
}

logChild('spawn ' + process.pid);

process.on('exit', () => {
  logChild('exit ' + process.pid);
});
process.on('SIGTERM', () => {
  process.exit(0);
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    logRequest(msg.method ? msg.method + ' ' + JSON.stringify(msg) : 'response ' + JSON.stringify(msg));

    if (msg.method === 'initialize') {
      send({
        id: msg.id,
        result: { userAgent: 'fake-codex', platformFamily: 'unix', platformOs: 'linux' },
      });
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
      send({ id: msg.id, result: { thread: { id: threadId } } });
      continue;
    }
    if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { id: msg.params.threadId || threadId } } });
      continue;
    }
    if (msg.method === 'turn/start') {
      const turnId = 'turn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const textInput = Array.isArray(msg.params.input)
        ? msg.params.input
            .filter((entry) => entry.type === 'text')
            .map((entry) => entry.text)
            .join('\\n')
        : '';
      activeTurn = {
        threadId: msg.params.threadId,
        turnId,
        textInput,
      };
      send({ id: msg.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        if (!activeTurn || activeTurn.turnId !== turnId) return;
        send({
          method: 'turn/started',
          params: { threadId: msg.params.threadId, turn: { id: turnId } },
        });
        if (crashDuringTurnTexts.has(textInput)) {
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: msg.params.threadId,
              turnId,
              itemId: 'item_msg',
              delta: '崩溃前输出',
            },
          });
          setTimeout(() => {
            process.exit(91);
          }, 20);
          return;
        }
        if (holdOpenTexts.has(textInput)) {
          return;
        }
        const replyText = Object.prototype.hasOwnProperty.call(repliesByText, textInput)
          ? repliesByText[textInput]
          : defaultReplyPrefix + textInput;
        setTimeout(() => {
          completeTurn(activeTurn, 'completed', replyText);
        }, completionDelayMs);
      }, 0);
      continue;
    }
    if (msg.method === 'turn/steer') {
      send({ id: msg.id, result: {} });
      const textInput = Array.isArray(msg.params.input)
        ? msg.params.input
            .filter((entry) => entry.type === 'text')
            .map((entry) => entry.text)
            .join('\\n')
        : '';
      if (activeTurn && msg.params.expectedTurnId === activeTurn.turnId) {
        const replyText = Object.prototype.hasOwnProperty.call(repliesByText, textInput)
          ? repliesByText[textInput]
          : defaultReplyPrefix + textInput;
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: activeTurn.threadId,
            turnId: activeTurn.turnId,
            itemId: 'item_msg',
            delta: '\\n[steered] ' + replyText,
          },
        });
      }
      continue;
    }
    if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      if (activeTurn) {
        completeTurn(activeTurn, 'interrupted', '');
      }
      continue;
    }
  }
});
`,
    'utf8',
  );
  fs.chmodSync(scriptPath, 0o755);
}

export function writeJsonAtomically(filePath, payload) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tempPath, filePath);
}

export async function waitFor(predicate, timeoutMs, description) {
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

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startPersistentRunnerHarness(options = {}) {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happypaw-persistent-runner-'),
  );
  const binDir = path.join(tempRoot, 'bin');
  const groupDir = path.join(tempRoot, 'group');
  const globalDir = path.join(tempRoot, 'global');
  const memoryDir = path.join(tempRoot, 'memory');
  const ipcInputDir = path.join(tempRoot, 'ipc', 'input');
  const homeDir = path.join(tempRoot, 'home');
  const codexHome = path.join(tempRoot, '.codex');
  const requestLogPath = path.join(tempRoot, 'requests.log');
  const childLogPath = path.join(tempRoot, 'children.log');

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(ipcInputDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const fakeCodexPath = path.join(binDir, 'codex');
  makeFakeCodexScript(
    fakeCodexPath,
    requestLogPath,
    childLogPath,
    options.codexOptions,
  );

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
      prompt: options.initialPrompt ?? '第一轮问题',
      sessionId: options.sessionId,
      runtime: 'codex_app_server',
      groupFolder: 'demo',
      chatJid: options.initialChatJid ?? 'web:demo',
      turnId: 'host-turn-1',
      isHome: false,
      isAdminHome: false,
    }),
  );

  return {
    tempRoot,
    groupDir,
    globalDir,
    memoryDir,
    ipcInputDir,
    requestLogPath,
    childLogPath,
    outputs,
    child,
    getStderr: () => stderrBuffer,
    readRequestLog: () =>
      fs.existsSync(requestLogPath) ? fs.readFileSync(requestLogPath, 'utf8') : '',
    readChildLog: () =>
      fs.existsSync(childLogPath) ? fs.readFileSync(childLogPath, 'utf8') : '',
    getRequestCount(method) {
      return this.readRequestLog()
        .split('\n')
        .filter((line) => line.startsWith(`${method} `)).length;
    },
    getSpawnPids() {
      return this.readChildLog()
        .split('\n')
        .filter((line) => line.startsWith('spawn '))
        .map((line) => Number(line.slice('spawn '.length)))
        .filter((value) => Number.isFinite(value));
    },
    getLatestSpawnPid() {
      const pids = this.getSpawnPids();
      return pids[pids.length - 1];
    },
    async waitForOutput(predicate, description, timeoutMs = 10_000) {
      await waitFor(() => outputs.some(predicate), timeoutMs, description);
      return outputs.find(predicate);
    },
    async waitForRequest(method, timeoutMs = 10_000) {
      await waitFor(
        () => this.readRequestLog().includes(`${method} `),
        timeoutMs,
        `${method} request`,
      );
    },
    sendIpcMessage(fileName, message) {
      writeJsonAtomically(path.join(ipcInputDir, fileName), {
        type: 'message',
        ...message,
      });
    },
    sendSentinel(name) {
      fs.writeFileSync(path.join(ipcInputDir, name), '');
    },
    async waitForExit(timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            new Error(
              `agent-runner did not exit in time\nSTDERR:\n${stderrBuffer}\nRequest log:\n${this.readRequestLog()}`,
            ),
          );
        }, timeoutMs);
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          if (signal) {
            reject(
              new Error(
                `agent-runner exited via signal ${signal}\nSTDERR:\n${stderrBuffer}\nRequest log:\n${this.readRequestLog()}`,
              ),
            );
            return;
          }
          resolve(code);
        });
      });
    },
    async forceKillIfRunning() {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

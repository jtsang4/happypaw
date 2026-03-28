#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const agentRunnerDist = path.join(repoRoot, 'container', 'agent-runner', 'dist');
const bridgeScriptPath = path.join(
  repoRoot,
  'container',
  'agent-runner',
  'codex-mcp-bridge.mjs',
);

function writeJsonLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function readJsonLineLines(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const messages = [];

    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!raw) continue;
        messages.push(JSON.parse(raw));
        if (messages.length >= 3) {
          cleanup();
          resolve(messages);
          return;
        }
      }
    };

    stream.on('data', onData);
    stream.on('error', onError);
  });
}

async function exerciseBridge(extraEnv = {}) {
  const proc = (await import('node:child_process')).spawn(
    'node',
    [bridgeScriptPath],
    {
      env: {
        ...process.env,
        HAPPYPAW_CHAT_JID: extraEnv.HAPPYPAW_CHAT_JID || 'telegram:test-chat',
        HAPPYPAW_GROUP_FOLDER: 'demo-folder',
        HAPPYPAW_OWNER_ID: 'owner-1',
        HAPPYPAW_RUNTIME: 'codex_app_server',
        HAPPYPAW_PRODUCT_ID: 'happypaw',
        HAPPYPAW_WORKSPACE_GROUP: extraEnv.HAPPYPAW_WORKSPACE_GROUP,
        HAPPYPAW_WORKSPACE_GLOBAL: extraEnv.HAPPYPAW_WORKSPACE_GLOBAL,
        HAPPYPAW_WORKSPACE_MEMORY: extraEnv.HAPPYPAW_WORKSPACE_MEMORY,
        HAPPYPAW_WORKSPACE_IPC: extraEnv.HAPPYPAW_WORKSPACE_IPC,
        HAPPYPAW_IS_HOME: extraEnv.HAPPYPAW_IS_HOME ?? '1',
        HAPPYPAW_IS_ADMIN_HOME: extraEnv.HAPPYPAW_IS_ADMIN_HOME ?? '0',
        HAPPYPAW_IS_SCHEDULED_TASK: extraEnv.HAPPYPAW_IS_SCHEDULED_TASK ?? '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  writeJsonLine(proc.stdin, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  writeJsonLine(proc.stdin, {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {},
  });
  writeJsonLine(proc.stdin, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  writeJsonLine(proc.stdin, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_context', arguments: {} },
  });

  const messages = await readJsonLineLines(proc.stdout);
  proc.stdin.end();
  await new Promise((resolve) => proc.on('close', resolve));
  if (stderr.trim()) {
    throw new Error(`Bridge stderr was not empty: ${stderr}`);
  }
  return messages;
}

function makePngBase64() {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5P4oQAAAAASUVORK5CYII=';
}

async function closeProc(proc) {
  proc.stdin.end();
  await new Promise((resolve) => proc.on('close', resolve));
}

function makeFakeCodexScript(scriptPath, requestLogPath, options = {}) {
  const failResumeThreadId = options.failResumeThreadId ?? null;
  const internalBridgeStatusName =
    options.internalBridgeStatusName ?? 'happypaw';
  const legacyMcpServerName = ['happy', 'claw'].join('');
  const requiredBridgeTools = JSON.stringify([
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
  ]);
  const mcpStatuses = JSON.stringify(
    options.mcpStatuses ?? [
      {
        name: internalBridgeStatusName,
        authStatus: 'bearerToken',
        tools: Object.fromEntries(
          [
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
          ].map((toolName) => [toolName, { name: toolName, inputSchema: {} }]),
        ),
        resources: [],
        resourceTemplates: [],
      },
    ],
  );
  const configWarnings = JSON.stringify(options.configWarnings ?? []);
  const turnConfig = JSON.stringify(options.turnConfig ?? {});
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const requestLogPath = ${JSON.stringify(requestLogPath)};
const failResumeThreadId = ${JSON.stringify(failResumeThreadId)};
const legacyMcpServerName = ${JSON.stringify(legacyMcpServerName)};
const requiredBridgeTools = ${requiredBridgeTools};
const mcpStatuses = ${mcpStatuses};
const configWarnings = ${configWarnings};
const turnConfig = ${turnConfig};
let buffer = '';
let activeTurn = null;
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
    log(msg.method ? msg.method + ' ' + JSON.stringify(msg) : 'response ' + JSON.stringify(msg));
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { userAgent: 'fake-codex', platformFamily: 'unix', platformOs: 'linux' } });
      continue;
    }
    if (msg.method === 'initialized') {
      for (const warning of configWarnings) {
        send({
          method: 'configWarning',
          params: warning,
        });
      }
      continue;
    }
    if (msg.method === 'mcpServerStatus/list') {
      const statuses = Array.isArray(mcpStatuses)
        ? mcpStatuses.map((status) => {
            if (status && typeof status === 'object') {
              return {
                resourceTemplates: [],
                resources: [],
                authStatus: 'bearerToken',
                tools: Object.fromEntries(
                  requiredBridgeTools.map((toolName) => [toolName, { name: toolName, inputSchema: {} }]),
                ),
                ...status,
              };
            }
            return status;
          })
        : [];
      send({ id: msg.id, result: { data: statuses, nextCursor: null } });
      continue;
    }
    if (msg.method === 'thread/start') {
      send({ id: msg.id, result: { thread: { id: freshThreadId } } });
      send({ method: 'thread/started', params: { thread: { id: freshThreadId } } });
      continue;
    }
    if (msg.method === 'thread/resume') {
      if (failResumeThreadId && msg.params.threadId === failResumeThreadId) {
        send({ id: msg.id, error: { code: -32001, message: 'stale thread' } });
        continue;
      }
      send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      continue;
    }
    if (msg.method === 'turn/start') {
      const turnId = turnConfig.turnId || 'turn_bootstrap';
      const completionStatus = turnConfig.completionStatus || 'completed';
      const completionDelayMs = turnConfig.completionDelayMs ?? 0;
      const greetingText = turnConfig.greetingText || '你好，Codex';
      const interruptItems = Array.isArray(turnConfig.interruptItems)
        ? turnConfig.interruptItems
        : [];
      const requestUserInput = turnConfig.requestUserInput || null;
      activeTurn = {
        threadId: msg.params.threadId,
        turnId,
        greetingText,
        completionStatus,
        interruptItems,
      };
      send({ id: msg.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        send({ method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: turnId } } });
        if (turnConfig.deferUntilInterrupt) {
          return;
        }
        if (requestUserInput) {
          send({
            id: requestUserInput.id || 'req_user_input',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: msg.params.threadId,
              turnId,
              itemId: requestUserInput.itemId || 'item_request_user_input',
              questions: requestUserInput.questions || [],
            }
          });
          return;
        }
        send({
          method: 'item/started',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'reasoning',
              id: 'item_reasoning',
              summary: ['先分析输入'],
              content: []
            }
          }
        });
        send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_reasoning', summaryIndex: 0, delta: '总结推理' } });
        send({ method: 'item/reasoning/textDelta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_reasoning', delta: '详细推理' } });
        send({
          method: 'item/started',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'reasoning',
              id: 'item_reasoning_part',
              summary: [],
              content: []
            }
          }
        });
        send({ method: 'item/reasoning/summaryPartAdded', params: { threadId: msg.params.threadId, turnId, itemId: 'item_reasoning_part', summaryIndex: 0 } });
        send({
          method: 'item/completed',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'reasoning',
              id: 'item_reasoning_part',
              summary: ['分段推理补充'],
              content: []
            }
          }
        });
        send({
          method: 'turn/plan/updated',
          params: {
            threadId: msg.params.threadId,
            turnId,
            explanation: '执行计划',
            plan: [
              { step: '分析问题', status: 'completed' },
              { step: '生成补丁', status: 'inProgress' },
              { step: '验证结果', status: 'pending' }
            ]
          }
        });
        send({
          method: 'item/started',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'commandExecution',
              id: 'item_command',
              command: 'ls -la'
            }
          }
        });
        send({ method: 'item/commandExecution/outputDelta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_command', delta: 'command output' } });
        send({
          method: 'item/completed',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'commandExecution',
              id: 'item_command',
              command: 'ls -la'
            }
          }
        });
        send({
          method: 'item/started',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'fileChange',
              id: 'item_patch'
            }
          }
        });
        send({ method: 'item/fileChange/outputDelta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_patch', delta: 'patch output' } });
        send({
          method: 'item/completed',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'fileChange',
              id: 'item_patch'
            }
          }
        });
        send({
          method: 'item/started',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'mcpToolCall',
              id: 'item_mcp',
              server: legacyMcpServerName,
              tool: 'send_message',
              arguments: { text: 'compatibility ping' }
            }
          }
        });
        send({ method: 'item/mcpToolCall/progress', params: { threadId: msg.params.threadId, turnId, itemId: 'item_mcp', message: 'mcp progress' } });
        send({
          method: 'item/completed',
          params: {
            threadId: msg.params.threadId,
            turnId,
            item: {
              type: 'mcpToolCall',
              id: 'item_mcp',
              server: legacyMcpServerName,
              tool: 'send_message',
              arguments: { text: 'compatibility ping' }
            }
          }
        });
        send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_msg', delta: greetingText } });
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
      }, 0);
      if (!turnConfig.deferUntilInterrupt) {
        setTimeout(() => {
          if (!activeTurn || activeTurn.turnId !== turnId) {
            return;
          }
          if (requestUserInput) {
            return;
          }
          send({
            method: 'turn/completed',
            params: {
              threadId: msg.params.threadId,
              turn: {
                id: turnId,
                status: completionStatus,
                items: [
                  { type: 'agentMessage', id: 'item_msg', text: greetingText, phase: 'final_answer', memoryCitation: null }
                ],
                error: null
              }
            }
          });
          send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_msg', delta: ' SHOULD_IGNORE' } });
          send({ method: 'item/commandExecution/outputDelta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_command', delta: 'IGNORED_AFTER_COMPLETION' } });
          activeTurn = null;
        }, completionDelayMs);
      }
      continue;
    }
    if (typeof msg.id !== 'undefined' && !msg.method && activeTurn && turnConfig.requestUserInput) {
      if (msg.error && typeof msg.error.message === 'string') {
        send({
          method: 'turn/completed',
          params: {
            threadId: activeTurn.threadId,
            turn: {
              id: activeTurn.turnId,
              status: 'failed',
              items: [],
              error: { message: msg.error.message }
            }
          }
        });
        activeTurn = null;
        continue;
      }
      const answers = msg.result && msg.result.answers ? msg.result.answers : {};
      const flattened = Object.values(answers)
        .flatMap((entry) => Array.isArray(entry.answers) ? entry.answers : [])
        .join(' / ');
      const responseText = flattened || turnConfig.requestUserInput.fallbackResponse || '已收到答案';
      send({ method: 'item/agentMessage/delta', params: { threadId: activeTurn.threadId, turnId: activeTurn.turnId, itemId: 'item_msg', delta: responseText } });
      send({
        method: 'turn/completed',
        params: {
          threadId: activeTurn.threadId,
          turn: {
            id: activeTurn.turnId,
            status: 'completed',
            items: [
              { type: 'agentMessage', id: 'item_msg', text: responseText, phase: 'final_answer', memoryCitation: null }
            ],
            error: null
          }
        }
      });
      activeTurn = null;
      continue;
    }
    if (msg.method === 'turn/steer') {
      send({ id: msg.id, result: {} });
      if (activeTurn && msg.params.expectedTurnId === activeTurn.turnId) {
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: activeTurn.threadId,
            turnId: activeTurn.turnId,
            itemId: 'item_msg',
            delta: '\\n[steered] ' + msg.params.input.map((entry) => entry.type === 'text' ? entry.text : '[image]').join(' | '),
          }
        });
      }
      continue;
    }
    if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      if (activeTurn) {
        for (const item of activeTurn.interruptItems) {
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: activeTurn.threadId,
              turnId: activeTurn.turnId,
              itemId: 'item_msg',
              delta: item,
            }
          });
        }
      }
      send({
        method: 'turn/completed',
        params: {
          threadId: msg.params.threadId,
          turn: { id: msg.params.turnId, status: 'interrupted', items: [], error: null }
        }
      });
      activeTurn = null;
      continue;
    }
  }
});
`,
    'utf8',
  );
  fs.chmodSync(scriptPath, 0o755);
}

async function runScenario(name, sessionId, options = {}) {
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
  makeFakeCodexScript(fakeCodex, requestLogPath, options);

  const outputs = [];
  const detectMime = options.detectImageMimeTypeFromBase64Strict
    || ((base64Data) => {
      if (typeof base64Data !== 'string') return undefined;
      if (base64Data.startsWith('iVBOR')) return 'image/png';
      if (base64Data.startsWith('/9j/')) return 'image/jpeg';
      if (base64Data.startsWith('R0lGOD')) return 'image/gif';
      if (base64Data.startsWith('UklGR')) return 'image/webp';
      return undefined;
    });
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.HOME = homeDir;
  process.env.CODEX_HOME = codeHome;
  process.env.HAPPYPAW_CODEX_EXECUTABLE = fakeCodex;
  process.env.HAPPYPAW_WORKSPACE_GROUP = groupDir;
  process.env.HAPPYPAW_WORKSPACE_GLOBAL = globalDir;
  process.env.HAPPYPAW_WORKSPACE_MEMORY = memoryDir;
  process.env.HAPPYPAW_WORKSPACE_IPC = path.join(tempRoot, 'ipc');
  process.env.HAPPYPAW_MCP_SERVER_ID =
    options.internalBridgeStatusName ?? 'happypaw';

  const { runCodexRuntime } = await import(
    path.join(agentRunnerDist, 'codex-runtime.js')
  );

  let result;
  let error;
  try {
    result = await runCodexRuntime({
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
        images: options.images,
        ...options.containerInputOverrides,
      },
      memoryRecall: 'memory recall prompt',
      images: options.images,
      deps: {
        WORKSPACE_GLOBAL: globalDir,
        WORKSPACE_GROUP: groupDir,
        WORKSPACE_MEMORY: memoryDir,
        SECURITY_RULES: 'security rules',
        log: () => {},
        writeOutput: (output) => outputs.push(output),
        shouldInterrupt: options.shouldInterrupt || (() => false),
        shouldClose: options.shouldClose || (() => false),
        shouldDrain: options.shouldDrain || (() => false),
        drainIpcInput:
          options.drainIpcInput ||
          (() => ({ messages: [] })),
        normalizeHomeFlags: (input) => ({
          isHome: Boolean(input.isHome),
          isAdminHome: Boolean(input.isAdminHome),
        }),
        buildChannelGuidelines: () => '',
        truncateWithHeadTail: (content) => content,
        generateTurnId: () => 'generated-turn-id',
      },
      detectImageMimeTypeFromBase64Strict: detectMime,
    });
  } catch (caughtError) {
    error = caughtError;
  }

  const requestOrder = fs
    .readFileSync(requestLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[0]);

  return { outputs, requestOrder, result, error, tempRoot };
}

const fresh = await runScenario('fresh', undefined);
const legacyMcpToolName = ['mcp', ['happy', 'claw'].join(''), 'send_message'].join(
  '__',
);
assert.deepEqual(fresh.requestOrder.slice(0, 4), [
  'initialize',
  'initialized',
  'mcpServerStatus/list',
  'thread/start',
]);
assert.equal(fresh.requestOrder[4], 'turn/start');
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

const agentThreadGuidelines = await runScenario(
  'agent-thread-guidelines',
  undefined,
  {
    containerInputOverrides: {
      agentId: 'agent-1',
      agentName: '会话助手',
    },
  },
);
const agentThreadStartLine = fs
  .readFileSync(path.join(agentThreadGuidelines.tempRoot, 'requests.log'), 'utf8')
  .split('\n')
  .find((line) => line.startsWith('thread/start '));
assert.ok(agentThreadStartLine, 'agent thread scenario logs thread/start payload');
const agentThreadStartPayload = JSON.parse(
  agentThreadStartLine.slice('thread/start '.length),
);
const agentThreadBaseInstructions =
  agentThreadStartPayload.params?.baseInstructions || '';
assert.match(
  agentThreadBaseInstructions,
  /不要用 `send_message` 发送"收到"之类的确认消息/,
  'agent-thread guidance still blocks acknowledgement spam via send_message',
);
assert.match(
  agentThreadBaseInstructions,
  /正式答复整合为一条最终输出/,
  'agent-thread guidance still prefers a single final assistant reply',
);
assert.match(
  agentThreadBaseInstructions,
  /允许使用 `send_message` 发送侧边消息/,
  'agent-thread guidance explicitly allows send_message side-channel usage',
);
assert.match(
  agentThreadBaseInstructions,
  /`send_message` 之后继续完成当前回合/,
  'agent-thread guidance keeps the final reply separate after side-channel updates',
);
assert.doesNotMatch(
  agentThreadBaseInstructions,
  /每次回复只产生一条消息/,
  'agent-thread guidance no longer hard-suppresses multi-message continuity',
);
assert.doesNotMatch(
  agentThreadBaseInstructions,
  /执行超过 2 分钟的长任务/,
  'agent-thread guidance no longer blocks progress updates behind a strict 2-minute threshold',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'thinking_delta' &&
      entry.streamEvent?.text === '先分析输入',
  ),
  'reasoning summary item emits a separate thinking delta',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'thinking_delta' &&
      entry.streamEvent?.text === '总结推理',
  ),
  'reasoning summary deltas remain separate from assistant text',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'thinking_delta' &&
      entry.streamEvent?.text === '详细推理',
  ),
  'reasoning text deltas stream separately',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'thinking_delta' &&
      entry.streamEvent?.text === '分段推理补充',
  ),
  'reasoning summary-part notifications surface through the thinking stream path',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_use_start' &&
      entry.streamEvent?.toolName === 'Bash' &&
      entry.streamEvent?.toolUseId === 'item_command',
  ),
  'command execution items map to Bash tool lifecycle events',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_use_end' &&
      entry.streamEvent?.toolUseId === 'item_command',
  ),
  'command execution completion emits tool_use_end',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_use_start' &&
      entry.streamEvent?.toolName === 'ApplyPatch' &&
      entry.streamEvent?.toolUseId === 'item_patch',
  ),
  'file change items map to ApplyPatch lifecycle events',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_progress' &&
      entry.streamEvent?.toolUseId === 'item_command' &&
      entry.streamEvent?.text === 'command output',
  ),
  'command output deltas translate into tool progress updates',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_progress' &&
      entry.streamEvent?.toolUseId === 'item_patch' &&
      entry.streamEvent?.text === 'patch output',
  ),
  'patch output deltas translate into tool progress updates',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_use_start' &&
      entry.streamEvent?.toolName === legacyMcpToolName &&
      entry.streamEvent?.toolUseId === 'item_mcp',
  ),
  'legacy MCP server names still map to the compatibility tool-use name',
);
assert.ok(
  fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_progress' &&
      entry.streamEvent?.toolUseId === 'item_mcp' &&
      entry.streamEvent?.text === 'mcp progress',
  ),
  'MCP progress notifications translate into tool progress updates',
);
const todoUpdate = fresh.outputs.find(
  (entry) =>
    entry.status === 'stream' &&
    entry.streamEvent?.eventType === 'todo_update',
)?.streamEvent;
assert.ok(todoUpdate, 'turn plan updates emit todo_update events');
assert.deepEqual(
  todoUpdate?.todos,
  [
    {
      id: 'codex-plan-turn_bootstrap-0',
      content: '分析问题',
      status: 'completed',
    },
    {
      id: 'codex-plan-turn_bootstrap-1',
      content: '生成补丁',
      status: 'in_progress',
    },
    {
      id: 'codex-plan-turn_bootstrap-2',
      content: '验证结果',
      status: 'pending',
    },
  ],
  'turn plan status values degrade into the existing todo shape',
);
const usageEvent = fresh.outputs.find(
  (entry) =>
    entry.status === 'stream' &&
    entry.streamEvent?.eventType === 'usage',
)?.streamEvent;
assert.deepEqual(
  usageEvent?.usage,
  {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 2,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    durationMs: usageEvent?.usage?.durationMs ?? 0,
    numTurns: 1,
  },
  'token usage degrades into the phase-1 compatibility shape',
);
assert.equal(
  usageEvent?.turnId,
  'turn-from-host',
  'usage events stay correlated with the active outer turn id',
);
assert.ok(
  !fresh.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      ((entry.streamEvent?.eventType === 'text_delta' &&
        entry.streamEvent?.text?.includes('SHOULD_IGNORE')) ||
        (entry.streamEvent?.eventType === 'tool_progress' &&
          entry.streamEvent?.text === 'IGNORED_AFTER_COMPLETION')),
  ),
  'post-completion deltas are ignored once the turn reaches a terminal state',
);
assert.equal(fresh.result.newSessionId, 'thr_fresh');
assert.equal(fresh.result.interruptedDuringQuery, false);

const resumed = await runScenario('resume', 'thr_saved');
assert.deepEqual(resumed.requestOrder.slice(0, 4), [
  'initialize',
  'initialized',
  'mcpServerStatus/list',
  'thread/resume',
]);
assert.equal(resumed.requestOrder[4], 'turn/start');
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

const resumeFallback = await runScenario('resume-fallback', 'thr_stale', {
  failResumeThreadId: 'thr_stale',
});
assert.deepEqual(resumeFallback.requestOrder.slice(0, 6), [
  'initialize',
  'initialized',
  'mcpServerStatus/list',
  'thread/resume',
  'thread/start',
  'turn/start',
]);
assert.ok(
  resumeFallback.outputs.some(
    (entry) =>
      entry.status === 'success' &&
      entry.result === '你好，Codex' &&
      entry.newSessionId === 'thr_fresh',
  ),
  'failed resume falls back to a fresh thread and keeps the conversation usable',
);
assert.equal(resumeFallback.result.newSessionId, 'thr_fresh');

const brokenBridge = await runScenario('broken-bridge', undefined, {
  mcpStatuses: [],
  configWarnings: [
    {
      summary: 'HappyPaw bridge command failed',
      details: 'spawn ENOENT node /bad/codex-mcp-bridge.mjs',
    },
  ],
});
assert.match(
  brokenBridge.error?.message || '',
  /HappyPaw MCP 桥接未成功注册或启动/u,
  'missing MCP bridge status fails the turn before Codex starts a thread',
);
assert.deepEqual(brokenBridge.requestOrder.slice(0, 3), [
  'initialize',
  'initialized',
  'mcpServerStatus/list',
]);
assert.ok(
  !brokenBridge.requestOrder.includes('thread/start') &&
    !brokenBridge.requestOrder.includes('turn/start'),
  'broken MCP bridge blocks the degraded turn before thread or turn start',
);
const brokenBridgeStatus = brokenBridge.outputs.find(
  (entry) =>
    entry.status === 'stream' &&
    entry.streamEvent?.eventType === 'status' &&
    typeof entry.streamEvent?.statusText === 'string' &&
    entry.streamEvent.statusText.includes('HappyPaw MCP 桥接未成功注册或启动'),
);
assert.ok(
  brokenBridgeStatus,
  'runtime emits an actionable status when the MCP bridge is missing',
);
assert.match(
  brokenBridgeStatus?.streamEvent?.statusText || '',
  /spawn ENOENT node \/bad\/codex-mcp-bridge\.mjs/u,
  'startup config warnings are included in the surfaced MCP bridge failure status',
);

const shadowBridgeStatus = await runScenario('shadow-bridge-status', undefined, {
  mcpStatuses: [
    {
      name: 'workspace-tools',
      authStatus: 'bearerToken',
      tools: Object.fromEntries(
        [
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
        ].map((toolName) => [toolName, { name: toolName, inputSchema: {} }]),
      ),
      resources: [],
      resourceTemplates: [],
    },
  ],
});
assert.match(
  shadowBridgeStatus.error?.message || '',
  /HappyPaw MCP 桥接未成功注册或启动/u,
  'unrelated MCP servers with matching tools cannot satisfy the reserved bridge health check',
);
assert.ok(
  !shadowBridgeStatus.requestOrder.includes('thread/start') &&
    !shadowBridgeStatus.requestOrder.includes('turn/start'),
  'reserved bridge identity mismatch blocks thread and turn startup',
);

const unauthenticatedBridge = await runScenario('unauthenticated-bridge', undefined, {
  mcpStatuses: [
    {
      name: 'happypaw',
      authStatus: 'notLoggedIn',
      tools: Object.fromEntries(
        [
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
        ].map((toolName) => [toolName, { name: toolName, inputSchema: {} }]),
      ),
      resources: [],
      resourceTemplates: [],
    },
  ],
});
assert.match(
  unauthenticatedBridge.error?.message || '',
  /authStatus=notLoggedIn/u,
  'unauthenticated reserved bridge fails startup health checks',
);
assert.ok(
  unauthenticatedBridge.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'status' &&
      typeof entry.streamEvent?.statusText === 'string' &&
      entry.streamEvent.statusText.includes('authStatus=notLoggedIn'),
  ),
  'runtime surfaces actionable status when the reserved bridge is unauthenticated',
);

const missingBridgeTools = await runScenario('missing-bridge-tools', undefined, {
  mcpStatuses: [
    {
      name: 'happypaw',
      authStatus: 'bearerToken',
      tools: Object.fromEntries(
        [
          'cancel_task',
          'get_context',
          'list_tasks',
          'memory_append',
          'memory_get',
          'memory_search',
          'pause_task',
          'resume_task',
          'schedule_task',
          'send_image',
          'send_message',
        ].map((toolName) => [toolName, { name: toolName, inputSchema: {} }]),
      ),
      resources: [],
      resourceTemplates: [],
    },
  ],
});
assert.match(
  missingBridgeTools.error?.message || '',
  /缺少必需工具：send_file/u,
  'reserved bridge missing required tools fails startup health checks',
);
assert.ok(
  missingBridgeTools.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'status' &&
      typeof entry.streamEvent?.statusText === 'string' &&
      entry.streamEvent.statusText.includes('缺少必需工具：send_file'),
  ),
  'runtime surfaces actionable status when the reserved bridge is missing required tools',
);

const nonHomeBridgeWithoutMemoryAppend = await runScenario(
  'non-home-bridge-without-memory-append',
  undefined,
  {
    mcpStatuses: [
      {
        name: 'happypaw',
        authStatus: 'bearerToken',
        tools: Object.fromEntries(
          [
            'cancel_task',
            'get_context',
            'list_tasks',
            'memory_get',
            'memory_search',
            'pause_task',
            'resume_task',
            'schedule_task',
            'send_file',
            'send_image',
            'send_message',
          ].map((toolName) => [toolName, { name: toolName, inputSchema: {} }]),
        ),
        resources: [],
        resourceTemplates: [],
      },
    ],
  },
);
assert.equal(
  nonHomeBridgeWithoutMemoryAppend.error,
  undefined,
  'non-home runtimes do not require memory_append during reserved bridge health checks',
);
assert.ok(
  nonHomeBridgeWithoutMemoryAppend.requestOrder.includes('thread/start') &&
    nonHomeBridgeWithoutMemoryAppend.requestOrder.includes('turn/start'),
  'non-home runtimes continue into thread and turn startup when memory_append is absent',
);

const bridgeTempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-codex-bridge-'),
);
const bridgeWorkspace = path.join(bridgeTempRoot, 'group');
const bridgeGlobal = path.join(bridgeTempRoot, 'global');
const bridgeMemory = path.join(bridgeTempRoot, 'memory');
const bridgeIpc = path.join(bridgeTempRoot, 'ipc');
fs.mkdirSync(bridgeWorkspace, { recursive: true });
fs.mkdirSync(bridgeGlobal, { recursive: true });
fs.mkdirSync(bridgeMemory, { recursive: true });
fs.mkdirSync(path.join(bridgeIpc, 'messages'), { recursive: true });
fs.mkdirSync(path.join(bridgeIpc, 'tasks'), { recursive: true });
fs.writeFileSync(
  path.join(bridgeIpc, 'active_im_reply_route.json'),
  JSON.stringify(
    {
      replyJid: 'telegram:home-route',
      updatedAt: '2026-03-26T00:00:00.000Z',
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(bridgeWorkspace, 'photo.png'),
  Buffer.from(makePngBase64(), 'base64'),
);
fs.writeFileSync(path.join(bridgeWorkspace, 'report.pdf'), '%PDF-1.4\n');
fs.writeFileSync(path.join(bridgeWorkspace, 'CLAUDE.md'), '偏好：喝热美式\n');
fs.writeFileSync(
  path.join(bridgeMemory, '2026-03-26.md'),
  '### 2026-03-26T00:00:00.000Z\n今天跟进 MCP bridge。\n',
);

const bridgeMessages = await exerciseBridge({
  HAPPYPAW_WORKSPACE_GROUP: bridgeWorkspace,
  HAPPYPAW_WORKSPACE_GLOBAL: bridgeGlobal,
  HAPPYPAW_WORKSPACE_MEMORY: bridgeMemory,
  HAPPYPAW_WORKSPACE_IPC: bridgeIpc,
  HAPPYPAW_CHAT_JID: 'telegram:test-chat',
  HAPPYPAW_IS_HOME: '1',
});
assert.equal(
  bridgeMessages[0].result.serverInfo.name,
  'happypaw-codex-bridge',
);
const bridgeTools = bridgeMessages[1].result.tools;
assert.deepEqual(
  bridgeTools.map((tool) => tool.name).sort(),
  [
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
  ],
  'phase-1 bridge tools are available through tools/list',
);
assert.deepEqual(
  bridgeTools.find((tool) => tool.name === 'send_message').inputSchema
    .properties,
  {
    text: {
      type: 'string',
      description: 'The message text to send',
    },
  },
  'bridge exposes send_message with the expected schema',
);
assert.match(
  bridgeMessages[2].result.content[0].text,
  /groupFolder=demo-folder[\s\S]*workspace=.*group[\s\S]*ownerId=owner-1[\s\S]*runtime=codex_app_server[\s\S]*productId=happypaw/,
  'bridge context still comes from environment variables',
);

const { spawn } = await import('node:child_process');
const bridgeProc = spawn('node', [bridgeScriptPath], {
  env: {
    ...process.env,
    HAPPYPAW_CHAT_JID: 'telegram:test-chat',
    HAPPYPAW_GROUP_FOLDER: 'demo-folder',
    HAPPYPAW_OWNER_ID: 'owner-1',
    HAPPYPAW_RUNTIME: 'codex_app_server',
    HAPPYPAW_PRODUCT_ID: 'happypaw',
    HAPPYPAW_WORKSPACE_GROUP: bridgeWorkspace,
    HAPPYPAW_WORKSPACE_GLOBAL: bridgeGlobal,
    HAPPYPAW_WORKSPACE_MEMORY: bridgeMemory,
    HAPPYPAW_WORKSPACE_IPC: bridgeIpc,
    HAPPYPAW_IS_HOME: '1',
    HAPPYPAW_IS_ADMIN_HOME: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
bridgeProc.stdout.setEncoding('utf8');
let bridgeBuffer = '';
const bridgeResponses = [];
bridgeProc.stdout.on('data', (chunk) => {
  bridgeBuffer += chunk;
  let idx;
  while ((idx = bridgeBuffer.indexOf('\n')) !== -1) {
    const raw = bridgeBuffer.slice(0, idx).trim();
    bridgeBuffer = bridgeBuffer.slice(idx + 1);
    if (!raw) continue;
    bridgeResponses.push(JSON.parse(raw));
  }
});
writeJsonLine(bridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
});
writeJsonLine(bridgeProc.stdin, {
  jsonrpc: '2.0',
  method: 'initialized',
  params: {},
});
for (const call of [
  { id: 2, name: 'send_message', arguments: { text: '进度仍在继续' } },
  { id: 3, name: 'send_image', arguments: { file_path: 'photo.png', caption: '截图' } },
  { id: 4, name: 'send_file', arguments: { filePath: 'report.pdf', fileName: 'report.pdf' } },
  {
    id: 5,
    name: 'schedule_task',
    arguments: {
      prompt: '总结日报',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
    },
  },
  { id: 6, name: 'pause_task', arguments: { task_id: 'task-1' } },
  { id: 7, name: 'resume_task', arguments: { task_id: 'task-1' } },
  { id: 8, name: 'cancel_task', arguments: { task_id: 'task-1' } },
  {
    id: 9,
    name: 'memory_append',
    arguments: { content: '记录：桥接工具已连通', date: '2026-03-26' },
  },
  { id: 10, name: 'memory_search', arguments: { query: '桥接工具', max_results: 5 } },
  { id: 11, name: 'memory_get', arguments: { file: '[memory] 2026-03-26.md' } },
]) {
  writeJsonLine(bridgeProc.stdin, {
    jsonrpc: '2.0',
    id: call.id,
    method: 'tools/call',
    params: {
      name: call.name,
      arguments: call.arguments,
    },
  });
}

const listTasksWait = new Promise((resolve, reject) => {
  const deadline = Date.now() + 5_000;
  const poll = () => {
    const listRequestFile = fs
      .readdirSync(path.join(bridgeIpc, 'tasks'))
      .find((file) => {
        if (!file.endsWith('.json') || file.startsWith('list_tasks_result_')) {
          return false;
        }
        const payload = JSON.parse(
          fs.readFileSync(path.join(bridgeIpc, 'tasks', file), 'utf8'),
        );
        return payload.type === 'list_tasks';
      });
    if (listRequestFile) {
      const payload = JSON.parse(
        fs.readFileSync(
          path.join(bridgeIpc, 'tasks', listRequestFile),
          'utf8',
        ),
      );
      fs.writeFileSync(
        path.join(
          bridgeIpc,
          'tasks',
          `list_tasks_result_${payload.requestId}.json`,
        ),
        JSON.stringify({
          success: true,
          tasks: [
            {
              id: 'task-1',
              prompt: '总结日报',
              schedule_type: 'interval',
              schedule_value: '60000',
              status: 'active',
              next_run: '2026-03-26T12:01:00.000Z',
            },
          ],
        }),
      );
      resolve();
      return;
    }
    if (Date.now() > deadline) {
      reject(new Error('Timed out waiting for list_tasks request file'));
      return;
    }
    setTimeout(poll, 25);
  };
  poll();
});
writeJsonLine(bridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 12,
  method: 'tools/call',
  params: {
    name: 'list_tasks',
    arguments: {},
  },
});
await listTasksWait;

const unsupportedBridgeProc = spawn('node', [bridgeScriptPath], {
  env: {
    ...process.env,
    HAPPYPAW_CHAT_JID: 'qq:test-chat',
    HAPPYPAW_GROUP_FOLDER: 'demo-folder',
    HAPPYPAW_OWNER_ID: 'owner-1',
    HAPPYPAW_RUNTIME: 'codex_app_server',
    HAPPYPAW_PRODUCT_ID: 'happypaw',
    HAPPYPAW_WORKSPACE_GROUP: bridgeWorkspace,
    HAPPYPAW_WORKSPACE_GLOBAL: bridgeGlobal,
    HAPPYPAW_WORKSPACE_MEMORY: bridgeMemory,
    HAPPYPAW_WORKSPACE_IPC: bridgeIpc,
    HAPPYPAW_IS_HOME: '0',
    HAPPYPAW_IS_ADMIN_HOME: '0',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
unsupportedBridgeProc.stdout.setEncoding('utf8');
let unsupportedBuffer = '';
const unsupportedResponses = new Map();
unsupportedBridgeProc.stdout.on('data', (chunk) => {
  unsupportedBuffer += chunk;
  let idx;
  while ((idx = unsupportedBuffer.indexOf('\n')) !== -1) {
    const raw = unsupportedBuffer.slice(0, idx).trim();
    unsupportedBuffer = unsupportedBuffer.slice(idx + 1);
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    if (typeof parsed.id !== 'undefined') unsupportedResponses.set(parsed.id, parsed);
  }
});
writeJsonLine(unsupportedBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
});
writeJsonLine(unsupportedBridgeProc.stdin, {
  jsonrpc: '2.0',
  method: 'initialized',
  params: {},
});
writeJsonLine(unsupportedBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'send_image',
    arguments: { file_path: 'photo.png' },
  },
});
writeJsonLine(unsupportedBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'send_file',
    arguments: { filePath: 'report.pdf', fileName: 'report.pdf' },
  },
});

const homeWebBridgeProc = spawn('node', [bridgeScriptPath], {
  env: {
    ...process.env,
    HAPPYPAW_CHAT_JID: 'web:home-demo',
    HAPPYPAW_GROUP_FOLDER: 'demo-folder',
    HAPPYPAW_OWNER_ID: 'owner-1',
    HAPPYPAW_RUNTIME: 'codex_app_server',
    HAPPYPAW_PRODUCT_ID: 'happypaw',
    HAPPYPAW_WORKSPACE_GROUP: bridgeWorkspace,
    HAPPYPAW_WORKSPACE_GLOBAL: bridgeGlobal,
    HAPPYPAW_WORKSPACE_MEMORY: bridgeMemory,
    HAPPYPAW_WORKSPACE_IPC: bridgeIpc,
    HAPPYPAW_IS_HOME: '1',
    HAPPYPAW_IS_ADMIN_HOME: '0',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
homeWebBridgeProc.stdout.setEncoding('utf8');
let homeWebBuffer = '';
const homeWebResponses = new Map();
homeWebBridgeProc.stdout.on('data', (chunk) => {
  homeWebBuffer += chunk;
  let idx;
  while ((idx = homeWebBuffer.indexOf('\n')) !== -1) {
    const raw = homeWebBuffer.slice(0, idx).trim();
    homeWebBuffer = homeWebBuffer.slice(idx + 1);
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    if (typeof parsed.id !== 'undefined') homeWebResponses.set(parsed.id, parsed);
  }
});
writeJsonLine(homeWebBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
});
writeJsonLine(homeWebBridgeProc.stdin, {
  jsonrpc: '2.0',
  method: 'initialized',
  params: {},
});
writeJsonLine(homeWebBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'send_message',
    arguments: { text: 'home web scope progress' },
  },
});
writeJsonLine(homeWebBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'send_image',
    arguments: { file_path: 'photo.png', caption: '家庭工作区截图' },
  },
});
writeJsonLine(homeWebBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'send_file',
    arguments: { filePath: 'report.pdf', fileName: 'report.pdf' },
  },
});

const agentBridgeIpc = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agent-web-bridge-'));
fs.mkdirSync(path.join(agentBridgeIpc, 'messages'), { recursive: true });
fs.mkdirSync(path.join(agentBridgeIpc, 'tasks'), { recursive: true });
const agentWebBridgeProc = spawn('node', [bridgeScriptPath], {
  env: {
    ...process.env,
    HAPPYPAW_CHAT_JID: 'web:workspace-a',
    HAPPYPAW_GROUP_FOLDER: 'workspace-a',
    HAPPYPAW_OWNER_ID: 'owner-1',
    HAPPYPAW_RUNTIME: 'codex_app_server',
    HAPPYPAW_PRODUCT_ID: 'happypaw',
    HAPPYPAW_WORKSPACE_GROUP: bridgeWorkspace,
    HAPPYPAW_WORKSPACE_GLOBAL: bridgeGlobal,
    HAPPYPAW_WORKSPACE_MEMORY: bridgeMemory,
    HAPPYPAW_WORKSPACE_IPC: agentBridgeIpc,
    HAPPYPAW_IS_HOME: '0',
    HAPPYPAW_IS_ADMIN_HOME: '0',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
agentWebBridgeProc.stdout.setEncoding('utf8');
let agentWebBuffer = '';
const agentWebResponses = new Map();
agentWebBridgeProc.stdout.on('data', (chunk) => {
  agentWebBuffer += chunk;
  let idx;
  while ((idx = agentWebBuffer.indexOf('\n')) !== -1) {
    const raw = agentWebBuffer.slice(0, idx).trim();
    agentWebBuffer = agentWebBuffer.slice(idx + 1);
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    if (typeof parsed.id !== 'undefined') agentWebResponses.set(parsed.id, parsed);
  }
});
writeJsonLine(agentWebBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
});
writeJsonLine(agentWebBridgeProc.stdin, {
  jsonrpc: '2.0',
  method: 'initialized',
  params: {},
});
writeJsonLine(agentWebBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'send_message',
    arguments: { text: 'agent scoped progress' },
  },
});

const homeUnsupportedIpc = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-web-unsupported-'));
fs.mkdirSync(path.join(homeUnsupportedIpc, 'messages'), { recursive: true });
fs.mkdirSync(path.join(homeUnsupportedIpc, 'tasks'), { recursive: true });
const homeUnsupportedBridgeProc = spawn('node', [bridgeScriptPath], {
  env: {
    ...process.env,
    HAPPYPAW_CHAT_JID: 'web:home-demo',
    HAPPYPAW_GROUP_FOLDER: 'demo-folder',
    HAPPYPAW_OWNER_ID: 'owner-1',
    HAPPYPAW_RUNTIME: 'codex_app_server',
    HAPPYPAW_PRODUCT_ID: 'happypaw',
    HAPPYPAW_WORKSPACE_GROUP: bridgeWorkspace,
    HAPPYPAW_WORKSPACE_GLOBAL: bridgeGlobal,
    HAPPYPAW_WORKSPACE_MEMORY: bridgeMemory,
    HAPPYPAW_WORKSPACE_IPC: homeUnsupportedIpc,
    HAPPYPAW_IS_HOME: '1',
    HAPPYPAW_IS_ADMIN_HOME: '0',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
homeUnsupportedBridgeProc.stdout.setEncoding('utf8');
let homeUnsupportedBuffer = '';
const homeUnsupportedResponses = new Map();
homeUnsupportedBridgeProc.stdout.on('data', (chunk) => {
  homeUnsupportedBuffer += chunk;
  let idx;
  while ((idx = homeUnsupportedBuffer.indexOf('\n')) !== -1) {
    const raw = homeUnsupportedBuffer.slice(0, idx).trim();
    homeUnsupportedBuffer = homeUnsupportedBuffer.slice(idx + 1);
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    if (typeof parsed.id !== 'undefined') homeUnsupportedResponses.set(parsed.id, parsed);
  }
});
writeJsonLine(homeUnsupportedBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
});
writeJsonLine(homeUnsupportedBridgeProc.stdin, {
  jsonrpc: '2.0',
  method: 'initialized',
  params: {},
});
writeJsonLine(homeUnsupportedBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'send_image',
    arguments: { file_path: 'photo.png' },
  },
});
writeJsonLine(homeUnsupportedBridgeProc.stdin, {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'send_file',
    arguments: { filePath: 'report.pdf', fileName: 'report.pdf' },
  },
});
await new Promise((resolve) => setTimeout(resolve, 100));
await closeProc(unsupportedBridgeProc);
await new Promise((resolve) => setTimeout(resolve, 100));
await closeProc(homeWebBridgeProc);
await new Promise((resolve) => setTimeout(resolve, 100));
await closeProc(agentWebBridgeProc);
await new Promise((resolve) => setTimeout(resolve, 100));
await closeProc(homeUnsupportedBridgeProc);

await new Promise((resolve) => setTimeout(resolve, 150));
await closeProc(bridgeProc);

const responseById = new Map(
  bridgeResponses
    .filter((response) => typeof response.id !== 'undefined')
    .map((response) => [response.id, response]),
);
assert.equal(responseById.get(2).result.content[0].text, 'Message sent.');
assert.match(
  responseById.get(3).result.content[0].text,
  /Image sent: photo\.png/,
);
assert.equal(
  responseById.get(4).result.content[0].text,
  'Sending file "report.pdf"...',
);
assert.match(
  responseById.get(5).result.content[0].text,
  /Task scheduled \[agent\]/,
);
assert.equal(
  responseById.get(6).result.content[0].text,
  'Task task-1 pause requested.',
);
assert.equal(
  responseById.get(7).result.content[0].text,
  'Task task-1 resume requested.',
);
assert.equal(
  responseById.get(8).result.content[0].text,
  'Task task-1 cancellation requested.',
);
assert.match(
  responseById.get(9).result.content[0].text,
  /已追加到 memory\/2026-03-26\.md/,
);
assert.match(
  responseById.get(10).result.content[0].text,
  /找到 1 条匹配/,
);
assert.match(
  responseById.get(11).result.content[0].text,
  /记录：桥接工具已连通/,
);
assert.match(
  responseById.get(12).result.content[0].text,
  /Scheduled tasks:\n- \[task-1\]/,
);
const unsupportedImageResponse = unsupportedResponses.get(2);
assert.equal(unsupportedImageResponse.result.isError, true);
assert.match(
  unsupportedImageResponse.result.content[0].text,
  /Current channel "qq" is unsupported/,
);
const unsupportedFileResponse = unsupportedResponses.get(3);
assert.equal(unsupportedFileResponse.result.isError, true);
assert.match(
  unsupportedFileResponse.result.content[0].text,
  /Current channel "qq" is unsupported/,
);
const homeWebMessageResponse = homeWebResponses.get(2);
assert.equal(homeWebMessageResponse.result.isError, undefined);
assert.equal(homeWebMessageResponse.result.content[0].text, 'Message sent.');
const homeWebImageResponse = homeWebResponses.get(3);
assert.equal(homeWebImageResponse.result.isError, undefined);
assert.match(
  homeWebImageResponse.result.content[0].text,
  /Image sent: photo\.png/,
);
const homeWebFileResponse = homeWebResponses.get(4);
assert.equal(homeWebFileResponse.result.isError, undefined);
assert.equal(
  homeWebFileResponse.result.content[0].text,
  'Sending file "report.pdf"...',
);
const agentWebMessageResponse = agentWebResponses.get(2);
assert.equal(agentWebMessageResponse.result.isError, undefined);
assert.equal(agentWebMessageResponse.result.content[0].text, 'Message sent.');
const homeUnsupportedImageResponse = homeUnsupportedResponses.get(2);
assert.equal(homeUnsupportedImageResponse.result.isError, true);
assert.match(
  homeUnsupportedImageResponse.result.content[0].text,
  /Current channel "web" is unsupported/,
);
const homeUnsupportedFileResponse = homeUnsupportedResponses.get(3);
assert.equal(homeUnsupportedFileResponse.result.isError, true);
assert.match(
  homeUnsupportedFileResponse.result.content[0].text,
  /Current channel "web" is unsupported/,
);

const messagePayloads = fs
  .readdirSync(path.join(bridgeIpc, 'messages'))
  .filter((file) => file.endsWith('.json'))
  .map((file) =>
    JSON.parse(fs.readFileSync(path.join(bridgeIpc, 'messages', file), 'utf8')),
  );
assert.equal(messagePayloads.length, 4);
assert.equal(
  messagePayloads.find((payload) => payload.type === 'message').text,
  '进度仍在继续',
  'send_message writes IPC without terminating the active turn',
);
assert.ok(
  messagePayloads.some(
    (payload) =>
      payload.type === 'message' &&
      payload.chatJid === 'web:home-demo' &&
      payload.text === 'home web scope progress',
  ),
  'home web standalone bridge keeps send_message persisted under the visible web scope even when an IM reply route snapshot exists',
);
assert.equal(
  messagePayloads.find((payload) => payload.type === 'image').mimeType,
  'image/png',
  'send_image writes image IPC payloads for supported channels',
);
assert.deepEqual(
  messagePayloads
    .filter((payload) => payload.type === 'image')
    .map((payload) => payload.chatJid)
    .sort(),
  ['telegram:home-route', 'telegram:test-chat'],
  'home web send_image reuses the active IM reply route when available',
);
const agentMessagePayloads = fs
  .readdirSync(path.join(agentBridgeIpc, 'messages'))
  .filter((file) => file.endsWith('.json'))
  .map((file) =>
    JSON.parse(fs.readFileSync(path.join(agentBridgeIpc, 'messages', file), 'utf8')),
  );
assert.equal(agentMessagePayloads.length, 1);
assert.equal(
  agentMessagePayloads[0].chatJid,
  'web:workspace-a',
  'agent-scoped standalone bridge keeps send_message on the visible web-backed scope so IPC/runtime can retain #agent continuity',
);
assert.equal(agentMessagePayloads[0].text, 'agent scoped progress');

const taskPayloads = fs
  .readdirSync(path.join(bridgeIpc, 'tasks'))
  .filter((file) => file.endsWith('.json') && !file.startsWith('list_tasks_result_'))
  .map((file) =>
    JSON.parse(fs.readFileSync(path.join(bridgeIpc, 'tasks', file), 'utf8')),
  );
assert.deepEqual(
  taskPayloads.map((payload) => payload.type).sort(),
  ['cancel_task', 'list_tasks', 'pause_task', 'resume_task', 'schedule_task', 'send_file', 'send_file'],
  'bridge task controls fan out to IPC payloads',
);
assert.deepEqual(
  taskPayloads
    .filter((payload) => payload.type === 'send_file')
    .map((payload) => payload.chatJid)
    .sort(),
  ['telegram:home-route', 'telegram:test-chat'],
  'home web send_file reuses the active IM reply route when available',
);

let interruptChecks = 0;
const interrupted = await runScenario('interrupt', 'thr_interrupt', {
  turnConfig: {
    deferUntilInterrupt: true,
    interruptItems: ['保留这段已生成文本'],
  },
  shouldInterrupt: () => {
    interruptChecks += 1;
    return interruptChecks >= 3;
  },
});
assert.ok(
  interrupted.requestOrder.includes('turn/interrupt'),
  'interrupt path requests turn/interrupt from Codex',
);
assert.equal(
  interrupted.result.interruptedDuringQuery,
  true,
  'interrupt result reports interrupted state',
);
assert.equal(
  interrupted.outputs.filter(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'text_delta',
  )[0]?.streamEvent?.text,
  '保留这段已生成文本',
  'partial output emitted before interrupt is preserved',
);

let steerDrainRead = 0;
const steered = await runScenario('steer', 'thr_steer', {
  turnConfig: {
    completionDelayMs: 200,
  },
  drainIpcInput: () => {
    steerDrainRead += 1;
    if (steerDrainRead === 2) {
      return {
        messages: [{ text: '继续补充这个回答' }],
      };
    }
    return { messages: [] };
  },
});
assert.ok(
  steered.requestOrder.includes('turn/steer'),
  'follow-up input while active turn uses turn/steer',
);
const steerTextDeltas = steered.outputs
  .filter(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'text_delta',
  )
  .map((entry) => entry.streamEvent.text);
assert.deepEqual(
  steerTextDeltas,
  ['你好，Codex', '\n[steered] 继续补充这个回答'],
  'steered output appends within the same active turn without replacing prior deltas',
);
assert.equal(
  steered.result.closedDuringQuery,
  false,
  'steer keeps the active turn running to normal completion',
);

const pngFixtureBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0FQAAAAASUVORK5CYII=';
const imageInput = await runScenario('image-input', undefined, {
  turnConfig: {
    greetingText: '我看到了上传的图片',
  },
  images: [{ data: pngFixtureBase64, mimeType: 'image/png' }],
});
const imageStartLine = fs
  .readFileSync(path.join(imageInput.tempRoot, 'requests.log'), 'utf8')
  .split('\n')
  .find((line) => line.startsWith('turn/start '));
assert.ok(
  imageStartLine && imageStartLine.includes('"type":"localImage"'),
  imageStartLine || 'missing turn/start payload log',
);
const imagePayload = JSON.parse(imageStartLine.slice('turn/start '.length));
const stagedPath = imagePayload.params?.input?.find((entry) => entry.type === 'localImage')?.path;
assert.ok(stagedPath && stagedPath.includes('.happypaw-input-images'), stagedPath);
assert.ok(
  !fs.existsSync(stagedPath),
  'staged local image is cleaned up after the turn finishes',
);
assert.ok(
  imageInput.outputs.some(
    (entry) =>
      entry.status === 'success' &&
      entry.result === '我看到了上传的图片',
  ),
  'image-capable turn still completes with the assistant response',
);

const requestUserInput = await runScenario('request-user-input', undefined, {
  turnConfig: {
    requestUserInput: {
      id: 'req_user_input',
      itemId: 'item_request_user_input',
      questions: [
        {
          id: 'favorite_pet',
          header: '补充信息',
          question: '你最喜欢的宠物是什么？',
          isOther: true,
          isSecret: false,
          options: [
            { label: '猫', description: '喵喵' },
            { label: '狗', description: '汪汪' },
          ],
        },
      ],
    },
    completionDelayMs: 0,
  },
  drainIpcInput: (() => {
    let reads = 0;
    return () => {
      reads += 1;
      if (reads >= 2) {
        return { messages: [{ text: '猫' }] };
      }
      return { messages: [] };
    };
  })(),
});
assert.ok(
  requestUserInput.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_use_start' &&
      entry.streamEvent?.toolName === 'AskUserQuestion' &&
      entry.streamEvent?.toolUseId === 'item_request_user_input' &&
      entry.streamEvent?.toolInput?.questions?.[0]?.question === '你最喜欢的宠物是什么？',
  ),
  'request_user_input is surfaced as AskUserQuestion with the original prompt payload',
);
assert.ok(
  requestUserInput.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_use_end' &&
      entry.streamEvent?.toolUseId === 'item_request_user_input',
  ),
  'request_user_input prompt closes after the answer is provided',
);
assert.ok(
  requestUserInput.outputs.some(
    (entry) =>
      entry.status === 'success' &&
      entry.result === '猫',
  ),
  'request_user_input answer resumes the same turn and yields the resumed assistant reply',
);

const multiQuestionRequestUserInput = await runScenario(
  'request-user-input-multi-question',
  undefined,
  {
    turnConfig: {
      requestUserInput: {
        id: 'req_user_input_multi',
        itemId: 'item_request_user_input_multi',
        questions: [
          {
            id: 'favorite_pet',
            header: '补充信息',
            question: '你最喜欢的宠物是什么？',
            isOther: true,
            isSecret: false,
            options: [
              { label: '猫', description: '喵喵' },
              { label: '狗', description: '汪汪' },
            ],
          },
          {
            id: 'favorite_color',
            header: '补充信息',
            question: '你最喜欢的颜色是什么？',
            isOther: true,
            isSecret: false,
            options: [
              { label: '蓝色', description: '冷静' },
              { label: '绿色', description: '自然' },
            ],
          },
        ],
      },
      completionDelayMs: 0,
    },
    drainIpcInput: (() => {
      let reads = 0;
      return () => {
        reads += 1;
        if (reads >= 2) {
          return { messages: [{ text: '猫\n蓝色' }] };
        }
        return { messages: [] };
      };
    })(),
  },
);
assert.ok(
  multiQuestionRequestUserInput.outputs.some(
    (entry) =>
      entry.status === 'stream' &&
      entry.streamEvent?.eventType === 'tool_use_start' &&
      entry.streamEvent?.toolUseId === 'item_request_user_input_multi' &&
      Array.isArray(entry.streamEvent?.toolInput?.questions) &&
      entry.streamEvent.toolInput.questions.length === 2,
  ),
  'multi-question request_user_input still surfaces the full prompt payload before rejection',
);
assert.match(
  multiQuestionRequestUserInput.error?.message || '',
  /HappyPaw 当前仅支持单题文本回答.*answers 映射/u,
  'multi-question request_user_input fails explicitly when HappyPaw cannot construct the required answers map',
);
assert.ok(
  !multiQuestionRequestUserInput.outputs.some(
    (entry) => entry.status === 'success',
  ),
  'unsupported multi-question request_user_input does not fabricate a success result',
);

const drained = await runScenario('drain', 'thr_drain', {
  turnConfig: {
    completionDelayMs: 200,
  },
  shouldDrain: (() => {
    let checks = 0;
    return () => {
      checks += 1;
      return checks >= 2;
    };
  })(),
});
assert.equal(
  drained.result.closedDuringQuery,
  true,
  'drain requests let the active turn finish and then exit cleanly',
);

const closed = await runScenario('close', 'thr_close', {
  turnConfig: {
    deferUntilInterrupt: true,
  },
  shouldClose: (() => {
    let checks = 0;
    return () => {
      checks += 1;
      return checks >= 2;
    };
  })(),
});
assert.equal(
  closed.result.closedDuringQuery,
  true,
  'close semantics exit the active turn path',
);
assert.ok(
  !closed.outputs.some((entry) => entry.status === 'success' && entry.result),
  'close does not fabricate a final success payload',
);

console.log('✅ codex runtime bootstrap checks passed');

#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const agentRunnerDist = path.join(repoRoot, 'container', 'agent-runner', 'dist');

function makeFakeCodexScript(scriptPath, requestLogPath, options = {}) {
  const failResumeThreadId = options.failResumeThreadId ?? null;
  const legacyMcpServerName = ['happy', 'claw'].join('');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const requestLogPath = ${JSON.stringify(requestLogPath)};
const failResumeThreadId = ${JSON.stringify(failResumeThreadId)};
const legacyMcpServerName = ${JSON.stringify(legacyMcpServerName)};
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
      if (failResumeThreadId && msg.params.threadId === failResumeThreadId) {
        send({ id: msg.id, error: { code: -32001, message: 'stale thread' } });
        continue;
      }
      send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      continue;
    }
    if (msg.method === 'turn/start') {
      const turnId = 'turn_bootstrap';
      send({ id: msg.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        send({ method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: turnId } } });
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
        send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_reasoning', delta: '总结推理' } });
        send({ method: 'item/reasoning/textDelta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_reasoning', delta: '详细推理' } });
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
        send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_msg', delta: ' SHOULD_IGNORE' } });
        send({ method: 'item/commandExecution/outputDelta', params: { threadId: msg.params.threadId, turnId, itemId: 'item_command', delta: 'IGNORED_AFTER_COMPLETION' } });
      }, 0);
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
const legacyMcpToolName = ['mcp', ['happy', 'claw'].join(''), 'send_message'].join(
  '__',
);
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

const resumeFallback = await runScenario('resume-fallback', 'thr_stale', {
  failResumeThreadId: 'thr_stale',
});
assert.deepEqual(resumeFallback.requestOrder.slice(0, 5), [
  'initialize',
  'initialized',
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

console.log('✅ codex runtime bootstrap checks passed');

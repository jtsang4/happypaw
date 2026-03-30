import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-routing-continuity-'),
);
const realTempRoot = fs.realpathSync(tempRoot);
process.chdir(realTempRoot);

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

const { initDatabase, closeDatabase, setRegisteredGroup, createAgent, updateAgentLastImJid } =
  await import(path.join(repoRoot, 'dist', 'db.js'));
const { createIpcRuntime } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'ipc-runtime.js')
);
const {
  getActiveImReplyRouteSnapshotPath,
  persistActiveImReplyRoute,
  resolveReplyRouteJid,
} = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'im-routing.js')
);
const { getScopedImReplyRouteSnapshotPath } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'chat-runtime',
    'im-reply-route-snapshot.js',
  )
);

initDatabase();

setRegisteredGroup('web:home-main', {
  name: 'Home Main',
  folder: 'home-1',
  added_at: new Date().toISOString(),
  created_by: 'user-1',
  is_home: true,
});
setRegisteredGroup('telegram:home-1', {
  name: 'Home Telegram',
  folder: 'home-1',
  added_at: new Date().toISOString(),
  created_by: 'user-1',
});
setRegisteredGroup('web:workspace-a', {
  name: 'Workspace A',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  created_by: 'user-1',
});

createAgent({
  id: 'agent-1',
  group_folder: 'workspace-a',
  chat_jid: 'web:workspace-a',
  name: 'Agent One',
  prompt: 'route test',
  status: 'idle',
  kind: 'conversation',
  created_by: 'user-1',
  created_at: new Date().toISOString(),
  completed_at: null,
  result_summary: null,
  last_im_jid: null,
  spawned_from_jid: null,
});

updateAgentLastImJid('agent-1', 'telegram:bound-agent');

const sentMessages = [];
const sentIms = [];
const sentImages = [];
const sentFiles = [];

persistActiveImReplyRoute('home-1', 'telegram:home-1');

assert.equal(
  resolveReplyRouteJid(
    new Map([['workspace-a', 'telegram:main-active']]),
    'workspace-a',
    'web:workspace-a',
    'agent-1',
    () => true,
  ),
  'telegram:bound-agent',
  'agent fallback routing prefers the persisted agent IM binding over folder-wide active IM state',
);

assert.equal(
  resolveReplyRouteJid(
    new Map([['home-1', 'telegram:home-1']]),
    'home-1',
    'web:home-main',
  ),
  'telegram:home-1',
  'main conversation fallback routing still uses the folder-wide active IM state',
);

const runtime = createIpcRuntime({
  dataDir: path.join(realTempRoot, 'data'),
  groupsDir: path.join(realTempRoot, 'data', 'groups'),
  mainGroupFolder: 'main',
  timezone: 'UTC',
  assistantName: 'HappyPaw',
  getRegisteredGroups: () => ({
    'web:home-main': {
      name: 'Home Main',
      folder: 'home-1',
      added_at: '',
      created_by: 'user-1',
      is_home: true,
    },
    'telegram:home-1': {
      name: 'Home Telegram',
      folder: 'home-1',
      added_at: '',
      created_by: 'user-1',
    },
    'web:workspace-a': {
      name: 'Workspace A',
      folder: 'workspace-a',
      added_at: '',
      created_by: 'user-1',
    },
  }),
  getShuttingDown: () => false,
  getActiveImReplyRoute: (folder) =>
    folder === 'home-1' ? 'telegram:home-1' : null,
  getAgentReplyRouteJid: (_folder, chatJid, agentId) => {
    if (agentId === 'agent-1') return 'telegram:bound-agent';
    if (chatJid === 'web:home-main') return 'telegram:home-1';
    return undefined;
  },
  sendMessage: async (jid, text, options) => {
    sentMessages.push({ jid, text, options });
    return `msg-${sentMessages.length}`;
  },
  ensureChatExists: () => {},
  storeMessageDirect: () => 'stored',
  broadcastNewMessage: () => {},
  broadcastToWebClients: () => {},
  extractLocalImImagePaths: () => [],
  sendImWithFailTracking: (jid, text) => {
    sentIms.push({ jid, text });
  },
  retryImOperation: async (_op, jid, fn) => {
    await fn();
    return true;
  },
  getChannelType: (jid) => {
    if (jid.startsWith('telegram:')) return 'telegram';
    if (jid.startsWith('web:')) return null;
    return null;
  },
  getGroupsByOwner: () => [],
  getConnectedChannelTypes: () => [],
  sendImage: async (jid, _buf, _mime, caption, fileName) => {
    sentImages.push({ jid, caption, fileName });
  },
  sendFile: async (jid, filePath, fileName) => {
    sentFiles.push({ jid, filePath, fileName });
  },
  createTask: () => {},
  deleteTask: () => {},
  getAllTasks: () => [],
  getTaskById: () => undefined,
  updateTask: () => {},
  syncGroupMetadata: async () => {},
  getAvailableGroups: () => [],
  writeGroupsSnapshot: () => {},
  registerGroup: () => {},
  installSkillForUser: async () => ({}),
  deleteSkillForUser: () => ({}),
});

runtime.startIpcWatcher();

const homeMessagesDir = path.join(realTempRoot, 'data', 'ipc', 'home-1', 'messages');
fs.mkdirSync(homeMessagesDir, { recursive: true });
fs.writeFileSync(
  path.join(homeMessagesDir, 'home-message.json'),
  JSON.stringify({
    type: 'message',
    chatJid: 'web:home-main',
    text: 'home continuity side channel',
  }),
);

const agentMessagesDir = path.join(
  realTempRoot,
  'data',
  'ipc',
  'workspace-a',
  'agents',
  'agent-1',
  'messages',
);
fs.mkdirSync(agentMessagesDir, { recursive: true });
fs.writeFileSync(
  path.join(agentMessagesDir, 'agent-message.json'),
  JSON.stringify({
    type: 'message',
    chatJid: 'web:workspace-a',
    text: 'agent scope side channel',
  }),
);

fs.mkdirSync(path.join(realTempRoot, 'data', 'groups', 'workspace-a'), {
  recursive: true,
});
fs.writeFileSync(
  path.join(realTempRoot, 'data', 'groups', 'workspace-a', 'report.txt'),
  'hello',
);
fs.writeFileSync(
  path.join(
    realTempRoot,
    'data',
    'ipc',
    'workspace-a',
    'agents',
    'agent-1',
    'file-send.json',
  ),
  '',
);
fs.writeFileSync(
  path.join(agentMessagesDir, 'ignored.json'),
  JSON.stringify({
    type: 'noop',
  }),
);

const agentTasksDir = path.join(
  realTempRoot,
  'data',
  'ipc',
  'workspace-a',
  'agents',
  'agent-1',
  'tasks',
);
fs.mkdirSync(agentTasksDir, { recursive: true });
fs.writeFileSync(
  path.join(agentTasksDir, 'send-file.json'),
  JSON.stringify({
    type: 'send_file',
    chatJid: 'web:workspace-a',
    filePath: 'report.txt',
    fileName: 'report.txt',
  }),
);

const imageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0QkAAAAASUVORK5CYII=',
  'base64',
);
fs.writeFileSync(
  path.join(agentMessagesDir, 'send-image.json'),
  JSON.stringify({
    type: 'image',
    chatJid: 'web:workspace-a',
    imageBase64: imageBuffer.toString('base64'),
    mimeType: 'image/png',
    fileName: 'proof.png',
  }),
);

const scopedSnapshot = getScopedImReplyRouteSnapshotPath(
  path.join(realTempRoot, 'data', 'ipc', 'workspace-a', 'agents', 'agent-1'),
);
assert.equal(
  scopedSnapshot,
  path.join(
    realTempRoot,
    'data',
    'ipc',
    'workspace-a',
    'agents',
    'agent-1',
    'active_im_reply_route.json',
  ),
);
assert.equal(
  getActiveImReplyRouteSnapshotPath('home-1'),
  path.join(realTempRoot, 'data', 'ipc', 'home-1', 'active_im_reply_route.json'),
);

await new Promise((resolve) => setTimeout(resolve, 5600));
runtime.closeAll();

assert.deepEqual(
  sentMessages.map(({ jid, text, options }) => ({
    jid,
    text,
    source: options?.source ?? null,
    sourceKind: options?.messageMeta?.sourceKind ?? null,
  })),
  [
    {
      jid: 'web:home-main',
      text: 'home continuity side channel',
      source: null,
      sourceKind: 'sdk_send_message',
    },
    {
      jid: 'web:workspace-a#agent:agent-1',
      text: 'agent scope side channel',
      source: 'agent_ipc',
      sourceKind: 'sdk_send_message',
    },
  ],
  'home workspace and agent side-channel messages stay in their intended scopes',
);

assert.deepEqual(
  sentIms,
  [
    { jid: 'telegram:home-1', text: 'home continuity side channel' },
    { jid: 'telegram:bound-agent', text: 'agent scope side channel' },
  ],
  'home and agent routes forward IM side-channels to the intended IM bindings',
);

assert.deepEqual(
  sentFiles,
  [
    {
      jid: 'telegram:bound-agent',
      filePath: path.join(
        realTempRoot,
        'data',
        'groups',
        'workspace-a',
        'report.txt',
      ),
      fileName: 'report.txt',
    },
  ],
  'agent-scoped file delivery resolves through the bound IM route',
);

assert.deepEqual(
  sentImages,
  [
    { jid: 'telegram:bound-agent', caption: undefined, fileName: 'proof.png' },
  ],
  'agent-scoped image delivery resolves through the bound IM route',
);

console.log('✅ routing continuity checks passed');

async function verifyRunnerReuseQueuedRouteContinuity() {
  const harnessRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happypaw-routing-runner-reuse-'),
  );
  const binDir = path.join(harnessRoot, 'bin');
  const groupDir = path.join(harnessRoot, 'group');
  const globalDir = path.join(harnessRoot, 'global');
  const memoryDir = path.join(harnessRoot, 'memory');
  const ipcDir = path.join(harnessRoot, 'ipc');
  const ipcInputDir = path.join(ipcDir, 'input');
  const homeDir = path.join(harnessRoot, 'home');
  const codexHome = path.join(harnessRoot, '.codex');
  const requestLogPath = path.join(harnessRoot, 'requests.log');
  const childLogPath = path.join(harnessRoot, 'children.log');
  const fakeCodexPath = path.join(binDir, 'codex');

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(ipcInputDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(requestLogPath, '', 'utf8');
  fs.writeFileSync(childLogPath, '', 'utf8');

  const fakeCodexScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const requestLogPath = ${JSON.stringify(requestLogPath)};
const childLogPath = ${JSON.stringify(childLogPath)};
const workspaceIpc = process.env.HAPPYPAW_WORKSPACE_IPC || '';
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
function writeInputMessage(fileName, payload) {
  const inputDir = path.join(workspaceIpc, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  const filePath = path.join(inputDir, fileName);
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tempPath, filePath);
}
function completeTurn(turn, text) {
  if (!turn || !activeTurn || activeTurn.turnId !== turn.turnId) return;
  send({
    method: 'item/agentMessage/delta',
    params: {
      threadId: turn.threadId,
      turnId: turn.turnId,
      itemId: 'item_msg',
      delta: text,
    },
  });
  send({
    method: 'turn/completed',
    params: {
      threadId: turn.threadId,
      turn: {
        id: turn.turnId,
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'item_msg',
            text,
            phase: 'final_answer',
            memoryCitation: null,
          },
        ],
        error: null,
      },
    },
  });
  activeTurn = null;
}

logChild('spawn ' + process.pid);
process.on('exit', () => logChild('exit ' + process.pid));
process.on('SIGTERM', () => process.exit(0));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    logRequest(
      msg.method
        ? msg.method + ' ' + JSON.stringify(msg)
        : 'response ' + JSON.stringify(msg),
    );
    if (msg.method === 'initialize') {
      send({
        id: msg.id,
        result: {
          userAgent: 'fake-codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      });
      continue;
    }
    if (msg.method === 'initialized') continue;
    if (msg.method === 'mcpServerStatus/list') {
      send({
        id: msg.id,
        result: {
          data: [
            {
              name: 'happypaw',
              authStatus: 'bearerToken',
              tools: {
                send_message: { name: 'send_message', inputSchema: {} },
                get_context: { name: 'get_context', inputSchema: {} },
                list_tasks: { name: 'list_tasks', inputSchema: {} },
                memory_append: { name: 'memory_append', inputSchema: {} },
                memory_get: { name: 'memory_get', inputSchema: {} },
                memory_search: { name: 'memory_search', inputSchema: {} },
                pause_task: { name: 'pause_task', inputSchema: {} },
                resume_task: { name: 'resume_task', inputSchema: {} },
                cancel_task: { name: 'cancel_task', inputSchema: {} },
                schedule_task: { name: 'schedule_task', inputSchema: {} },
                send_file: { name: 'send_file', inputSchema: {} },
                send_image: { name: 'send_image', inputSchema: {} },
              },
              resources: [],
              resourceTemplates: [],
            },
          ],
          nextCursor: null,
        },
      });
      continue;
    }
    if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      continue;
    }
    if (msg.method === 'thread/start') {
      send({ id: msg.id, result: { thread: { id: 'thread-default' } } });
      continue;
    }
    if (msg.method === 'turn/start') {
      const textInput = Array.isArray(msg.params.input)
        ? msg.params.input
            .filter((entry) => entry.type === 'text')
            .map((entry) => entry.text)
            .join('\\n')
        : '';
      const turnId = 'turn_' + Date.now();
      activeTurn = { threadId: msg.params.threadId, turnId, textInput };
      send({ id: msg.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        if (!activeTurn || activeTurn.turnId !== turnId) return;
        send({
          method: 'turn/started',
          params: { threadId: msg.params.threadId, turn: { id: turnId } },
        });
        if (textInput === '初始消息') {
          writeInputMessage('001-stale-context.json', {
            type: 'message',
            text: '旧会话排队消息',
            sessionId: 'thread-a',
            chatJid: 'web:workspace-a',
            replyRouteJid: 'qq:route-a',
          });
          writeInputMessage('002-latest-context.json', {
            type: 'message',
            text: '切换到会话B',
            sessionId: 'thread-b',
            chatJid: 'web:workspace-b',
            replyRouteJid: 'telegram:route-b',
          });
          completeTurn(activeTurn, '初始消息回复');
          return;
        }
        completeTurn(activeTurn, '排队消息已处理');
      }, 0);
      continue;
    }
    if (msg.method === 'turn/interrupt' || msg.method === 'turn/steer') {
      send({ id: msg.id, result: {} });
      continue;
    }
  }
});
`;

  fs.writeFileSync(fakeCodexPath, fakeCodexScript, 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

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
        HAPPYPAW_WORKSPACE_IPC: ipcDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const outputs = [];
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let markerOpen = false;
  let markerJson = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const rawLine = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      const line = rawLine.replace(/\r$/, '');
      if (line === '---HAPPYPAW_OUTPUT_START---') {
        markerOpen = true;
        markerJson = '';
        continue;
      }
      if (line === '---HAPPYPAW_OUTPUT_END---') {
        if (markerOpen) outputs.push(JSON.parse(markerJson));
        markerOpen = false;
        markerJson = '';
        continue;
      }
      if (markerOpen) markerJson += line;
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
  });

  child.stdin.end(
    JSON.stringify({
      prompt: '初始消息',
      sessionId: 'thread-a',
      runtime: 'codex_app_server',
      groupFolder: 'home-1',
      chatJid: 'web:workspace-a',
      replyRouteJid: 'telegram:route-a',
      turnId: 'route-turn-1',
      isHome: true,
      isAdminHome: false,
    }),
  );

  try {
    await waitFor(
      () =>
        outputs.some(
          (entry) =>
            entry.status === 'success' && entry.result === '初始消息回复',
        ),
      10_000,
      'initial runner-reuse route response',
    );
    await waitFor(
      () =>
        outputs.some(
          (entry) =>
            entry.status === 'success' && entry.result === '排队消息已处理',
        ),
      10_000,
      'runner-reuse queued route response',
    );

    fs.writeFileSync(path.join(ipcInputDir, '_close'), '');
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `route continuity runner harness timeout\\nSTDERR:\\n${stderrBuffer}`,
          ),
        );
      }, 10_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (signal) {
          reject(
            new Error(
              `route continuity runner harness exited via signal ${signal}\\nSTDERR:\\n${stderrBuffer}`,
            ),
          );
          return;
        }
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderrBuffer);

    const requestLog = fs.readFileSync(requestLogPath, 'utf8');
    const threadResumeRequests = requestLog
      .split('\n')
      .filter((line) => line.startsWith('thread/resume '))
      .map((line) => JSON.parse(line.slice('thread/resume '.length)));
    const secondResumeRequest = threadResumeRequests.at(-1);
    assert.equal(
      secondResumeRequest?.params?.threadId,
      'thread-b',
      'runner reuse should resume the latest queued conversation session',
    );
    assert.match(
      secondResumeRequest?.params?.baseInstructions ?? '',
      /## Telegram 消息格式/,
      'runner reuse should rebuild channel routing guidance from the latest queued reply route',
    );
    assert.doesNotMatch(
      secondResumeRequest?.params?.baseInstructions ?? '',
      /## QQ 消息格式/,
      'stale queued route metadata must not leak into the reused runner follow-up turn',
    );
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
}

await verifyRunnerReuseQueuedRouteContinuity();
closeDatabase();
process.exit(0);

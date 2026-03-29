#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-task-im-helper-'),
);

process.chdir(tempRoot);
process.env.OPENAI_BASE_URL = 'https://env.example.com/v1';
process.env.OPENAI_API_KEY = 'env-api-key';
process.env.OPENAI_MODEL = 'gpt-5.1-mini';

const [
  { Hono },
  tasksRoutesModule,
  dbCoreModule,
  dbSharedModule,
  dbUsersAuthModule,
  authHelpersModule,
  authRoutesModule,
  configModule,
  runtimeConfigModule,
  imCommandUtilsModule,
  slashCommandsModule,
] = await Promise.all([
  import('hono'),
  import(
    path.join(repoRoot, 'dist', 'features', 'tasks', 'routes', 'tasks.js')
  ),
  import(path.join(repoRoot, 'dist', 'db', 'core.js')),
  import(path.join(repoRoot, 'dist', 'db', 'shared.js')),
  import(path.join(repoRoot, 'dist', 'db', 'users-auth.js')),
  import(path.join(repoRoot, 'dist', 'features', 'auth', 'auth.js')),
  import(
    path.join(repoRoot, 'dist', 'features', 'auth', 'routes', 'auth.js')
  ),
  import(path.join(repoRoot, 'dist', 'config.js')),
  import(path.join(repoRoot, 'dist', 'runtime-config.js')),
  import(path.join(repoRoot, 'dist', 'features', 'im', 'im-command-utils.js')),
  import(
    path.join(
      repoRoot,
      'dist',
      'features',
      'chat-runtime',
      'slash-commands.js',
    )
  ),
]);

const tasksRoutes = tasksRoutesModule.default;
const { setDatabaseInstance, db } = dbSharedModule;
const { createUser, createUserSession } = dbUsersAuthModule;
const { hashPassword, sessionExpiresAt } = authHelpersModule;
const { setSessionCookieHeaders } = authRoutesModule;
const { STORE_DIR } = configModule;
const {
  saveCodexProviderConfig,
  saveCodexProviderSecrets,
  getCodexProviderConfigWithSource,
} = runtimeConfigModule;
const { getRecallCommandUnavailableMessage, formatWorkspaceList } =
  imCommandUtilsModule;
const { createSlashCommandHandlers } = slashCommandsModule;
const { ensureChatExists, setRegisteredGroup, storeMessageDirect } =
  await import(path.join(repoRoot, 'dist', 'db.js'));

fs.mkdirSync(STORE_DIR, { recursive: true });
setDatabaseInstance(new Database(path.join(STORE_DIR, 'messages.db')));
dbCoreModule.initDatabase();

saveCodexProviderConfig({
  openaiBaseUrl: 'https://runtime.example.com/v1',
  openaiModel: 'gpt-5.1-mini',
});
saveCodexProviderSecrets({
  openaiApiKey: 'runtime-secret-key',
});

const passwordHash = await hashPassword('password123');
createUser({
  id: 'admin-user',
  username: 'admin',
  password_hash: passwordHash,
  display_name: 'Admin',
  role: 'admin',
  status: 'active',
  must_change_password: false,
  notes: '',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});
createUserSession({
  id: 'session-token',
  user_id: 'admin-user',
  ip_address: '127.0.0.1',
  user_agent: 'test-agent',
  created_at: new Date().toISOString(),
  expires_at: sessionExpiresAt(),
  last_active_at: new Date().toISOString(),
});

const workspaceJid = 'web:helper-workspace';
ensureChatExists(workspaceJid);
setRegisteredGroup(workspaceJid, {
  name: 'Helper Workspace',
  folder: 'helper-workspace',
  added_at: new Date().toISOString(),
  executionMode: 'container',
  created_by: 'admin-user',
  is_home: false,
});

storeMessageDirect(
  'msg-user-1',
  workspaceJid,
  'user',
  '用户',
  '今天请整理一下待办事项',
  new Date().toISOString(),
  false,
);
storeMessageDirect(
  'msg-ai-1',
  workspaceJid,
  'assistant',
  'HappyPaw',
  '好的，我会整理待办事项。',
  new Date().toISOString(),
  true,
);

const app = new Hono();
app.route('/api/tasks', tasksRoutes);

const cookieHeaders = setSessionCookieHeaders(
  { req: { header: () => undefined, url: 'http://localhost/api/tasks/parse' } },
  'session-token',
);
const cookie = cookieHeaders.getSetCookie()[0].split(';')[0];

let capturedRequest = null;
globalThis.fetch = async (url, init) => {
  capturedRequest = {
    url: String(url),
    method: init?.method || 'GET',
    headers: init?.headers,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  };

  return new Response(
    JSON.stringify({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                prompt: '整理最新科技新闻并输出摘要',
                schedule_type: 'cron',
                schedule_value: '0 9 * * *',
                context_mode: 'isolated',
                summary: '每天上午 9 点执行新闻摘要任务',
              }),
            },
          ],
        },
      ],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
};

const parseResponse = await app.request('/api/tasks/parse', {
  method: 'POST',
  headers: {
    Cookie: cookie,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    description: '每天上午 9 点整理最新科技新闻并输出摘要',
  }),
});

assert.equal(parseResponse.status, 200);
const parsePayload = await parseResponse.json();
assert.equal(parsePayload.success, true);
assert.equal(parsePayload.parsed.schedule_type, 'cron');
assert.equal(parsePayload.parsed.schedule_value, '0 9 * * *');
assert.equal(parsePayload.parsed.context_mode, 'isolated');
assert.equal(parsePayload.parsed.summary, '每天上午 9 点执行新闻摘要任务');
assert.equal(parsePayload.parsed.prompt, '整理最新科技新闻并输出摘要');
assert.equal(
  capturedRequest.url,
  'https://runtime.example.com/v1/responses',
  'task helper should call Codex responses endpoint instead of the removed CLI',
);
assert.equal(capturedRequest.method, 'POST');
assert.equal(
  capturedRequest.body.model,
  'gpt-5.1-mini',
  'task helper should use the configured Codex model',
);
assert.match(
  String(capturedRequest.headers.Authorization),
  /^Bearer runtime-secret-key$/,
);

const helperUnavailable = getRecallCommandUnavailableMessage();
assert.match(helperUnavailable, /Codex-only/u);
assert.match(helperUnavailable, /已移除 \/recall/u);

const workspaceList = formatWorkspaceList(
  [{ folder: 'helper-workspace', name: 'Helper Workspace', agents: [] }],
  'helper-workspace',
  null,
  true,
);
assert.match(workspaceList, /\/status 状态/u);
assert.doesNotMatch(workspaceList, /\/recall/u);

const handlers = createSlashCommandHandlers({
  queue: {
    getStatus: () => ({
      activeContainerCount: 0,
      activeHostProcessCount: 0,
      maxContainers: 0,
      maxHostProcesses: 0,
      waitingCount: 0,
      waitingGroupJids: [],
    }),
  },
  sessions: {},
  registeredGroups: {
    [workspaceJid]: {
      name: 'Helper Workspace',
      folder: 'helper-workspace',
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'admin-user',
      is_home: false,
    },
  },
  imSendFailCounts: new Map(),
  imHealthCheckFailCounts: new Map(),
  setCursors: () => {},
  registerGroup: () => {},
  unbindImGroup: () => {},
  resolveEffectiveGroup: (group) => ({ effectiveGroup: group, isHome: false }),
  processAgentConversation: async () => {},
});

const recallResponse = await handlers.handleCommand(workspaceJid, 'recall');
assert.equal(recallResponse, helperUnavailable);

const shortRecallResponse = await handlers.handleCommand(workspaceJid, 'rc');
assert.equal(shortRecallResponse, helperUnavailable);

const { config, source } = getCodexProviderConfigWithSource();
assert.equal(source, 'runtime');
assert.equal(config.openaiBaseUrl, 'https://runtime.example.com/v1');

console.log('✅ task-and-im-helper-cutover assertions passed');

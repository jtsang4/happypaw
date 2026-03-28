#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-agent-definition-surface-runtime-'),
);
const tempHome = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-agent-definition-surface-'),
);

process.chdir(tempRoot);
process.env.HOME = tempHome;

const [
  { Hono },
  routeModule,
  dbCoreModule,
  dbSharedModule,
  dbUsersAuthModule,
  authHelpersModule,
  configModule,
] = await Promise.all([
  import('hono'),
  import(path.join(repoRoot, 'dist', 'routes', 'agent-definitions.js')),
  import(path.join(repoRoot, 'dist', 'db', 'core.js')),
  import(path.join(repoRoot, 'dist', 'db', 'shared.js')),
  import(path.join(repoRoot, 'dist', 'db', 'users-auth.js')),
  import(path.join(repoRoot, 'dist', 'auth.js')),
  import(path.join(repoRoot, 'dist', 'config.js')),
]);

const routes = routeModule.default;
const { setDatabaseInstance } = dbSharedModule;
const { createUser, createUserSession } = dbUsersAuthModule;
const { hashPassword, sessionExpiresAt } = authHelpersModule;
const { STORE_DIR, SESSION_COOKIE_NAME_PLAIN } = configModule;

fs.mkdirSync(STORE_DIR, { recursive: true });
setDatabaseInstance(new Database(path.join(STORE_DIR, 'messages.db')));
dbCoreModule.initDatabase();

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

const app = new Hono();
app.route('/api/agent-definitions', routes);

const agentId = 'ops-helper';
const agentName = 'Ops Helper';
const initialBody = '# Ops Helper\n\nHandle operator workflows.\n';
const updatedBody = '# Ops Helper\n\nUpdated instructions.\n';
const projectAgentsDir = path.join(tempRoot, '.codex', 'agents');
const globalAgentsDir = path.join(tempHome, '.codex', 'agents');
const expectedProjectFilePath = path.join(projectAgentsDir, `${agentId}.toml`);
const expectedGlobalFilePath = path.join(globalAgentsDir, 'global-helper.toml');

fs.mkdirSync(projectAgentsDir, { recursive: true });
fs.mkdirSync(globalAgentsDir, { recursive: true });

fs.writeFileSync(
  expectedGlobalFilePath,
  [
    'name = "global-helper"',
    'description = "global only"',
    'model = "inherit"',
    'tools = ["Read"]',
    '',
    'prompt = """',
    'Global instructions',
    '"""',
    '',
  ].join('\n'),
  'utf8',
);

async function request(
  targetPath,
  init = {},
) {
  return app.request(targetPath, {
    ...init,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME_PLAIN}=session-token`,
      ...(init.headers ?? {}),
    },
  });
}

const createResponse = await request('/api/agent-definitions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: agentName, content: initialBody }),
});
assert.equal(createResponse.status, 200, 'create should succeed');
const createPayload = await createResponse.json();
assert.equal(createPayload.id, agentId, 'create should slugify the agent name');
assert.equal(
  createPayload.storageMode,
  'project',
  'project mode should be the default storage mode',
);

assert.ok(
  fs.existsSync(expectedProjectFilePath),
  'create should write the stored file into workspace-local .codex/agents',
);
const createdContent = fs.readFileSync(expectedProjectFilePath, 'utf8');
assert.match(
  createdContent,
  /^name = "ops-helper"\ndescription = ""\nmodel = "inherit"\ntools = \[\]\n\nprompt = """\n# Ops Helper/m,
  'create should inject compatible TOML content for project-scoped definitions',
);

const listResponse = await request('/api/agent-definitions');
assert.equal(listResponse.status, 200, 'list should succeed');
const listPayload = await listResponse.json();
assert.equal(listPayload.agents.length, 1, 'list should include the created definition');
assert.equal(listPayload.agents[0].id, agentId);
assert.equal(listPayload.agents[0].name, agentId);
assert.equal(
  listPayload.storageMode,
  'project',
  'default list should stay on project storage mode',
);
assert.equal(
  fs.realpathSync(listPayload.storagePath),
  fs.realpathSync(projectAgentsDir),
  'default list should point at the workspace-local Codex agent directory',
);

const detailResponse = await request(`/api/agent-definitions/${agentId}`);
assert.equal(detailResponse.status, 200, 'detail should succeed');
const detailPayload = await detailResponse.json();
assert.equal(detailPayload.agent.id, agentId);
assert.match(
  detailPayload.agent.content,
  /model = "inherit"/u,
  'detail should preserve injected TOML content',
);

const updateResponse = await request(`/api/agent-definitions/${agentId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: updatedBody }),
});
assert.equal(updateResponse.status, 200, 'update should succeed');
const updatedContent = fs.readFileSync(expectedProjectFilePath, 'utf8');
assert.match(
  updatedContent,
  /^name = "ops-helper"\ndescription = ""\nmodel = "inherit"\ntools = \[\]\n\nprompt = """\n# Ops Helper\n\nUpdated instructions\./m,
  'update should preserve required TOML fields when overwriting content',
);

const defaultDoesNotAutoAdoptGlobal = await request('/api/agent-definitions');
const defaultPayload = await defaultDoesNotAutoAdoptGlobal.json();
assert.equal(
  defaultPayload.agents.some((agent) => agent.id === 'global-helper'),
  false,
  'default project mode must not auto-detect real or temp global Codex agents',
);

const globalListResponse = await request('/api/agent-definitions?storageMode=global');
assert.equal(globalListResponse.status, 200, 'global list should succeed when explicitly enabled');
const globalListPayload = await globalListResponse.json();
assert.equal(
  globalListPayload.storageMode,
  'global',
  'explicit global list should report global storage mode',
);
assert.equal(
  fs.realpathSync(globalListPayload.storagePath),
  fs.realpathSync(globalAgentsDir),
  'explicit global list should point at the sandboxed home Codex agent directory',
);
assert.equal(
  globalListPayload.agents.some((agent) => agent.id === 'global-helper'),
  true,
  'explicit global mode should read user-global Codex agents from the sandbox home',
);

const agentDefinitionsPage = fs.readFileSync(
  path.join(repoRoot, 'web', 'src', 'pages', 'AgentDefinitionsPage.tsx'),
  'utf8',
);
assert.match(
  agentDefinitionsPage,
  /Agent 管理/u,
  'settings surface should stay Agent-branded',
);
assert.match(
  agentDefinitionsPage,
  /\.codex\/agents\/\*\.toml/u,
  'settings surface should describe Codex agent storage paths',
);
assert.match(
  agentDefinitionsPage,
  /不会自动探测或接管/u,
  'settings surface should explain that global mode is explicit and never auto-adopted',
);
assert.doesNotMatch(
  agentDefinitionsPage,
  /Droid|subagent_type/u,
  'settings surface should not ship Droid-branded or Task guidance copy',
);

console.log('✅ agent-definition-surface-cleanup assertions passed');
fs.rmSync(tempRoot, { recursive: true, force: true });
fs.rmSync(tempHome, { recursive: true, force: true });
process.exit(0);

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
createUser({
  id: 'member-user',
  username: 'member',
  password_hash: passwordHash,
  display_name: 'Member',
  role: 'member',
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
createUserSession({
  id: 'member-session-token',
  user_id: 'member-user',
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
  sessionToken = 'session-token',
) {
  return app.request(targetPath, {
    ...init,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME_PLAIN}=${sessionToken}`,
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

const createdAgentPath = path.join(globalAgentsDir, `${agentId}.toml`);
assert.ok(
  fs.existsSync(createdAgentPath),
  'create should write the stored file into sandboxed ~/.codex/agents',
);
assert.deepEqual(
  fs.readdirSync(projectAgentsDir),
  [],
  'default-global behavior should not create workspace-local agent files',
);
const createdContent = fs.readFileSync(createdAgentPath, 'utf8');
assert.match(
  createdContent,
  /^name = "ops-helper"\ndescription = ""\nmodel = "inherit"\ntools = \[\]\n\nprompt = """\n# Ops Helper/m,
  'create should inject compatible TOML content for default-global definitions',
);

const listResponse = await request('/api/agent-definitions');
assert.equal(listResponse.status, 200, 'list should succeed');
const listPayload = await listResponse.json();
assert.equal(listPayload.agents.length, 2, 'list should include both the created and preseeded global definitions');
assert.equal(
  listPayload.agents.some((agent) => agent.id === agentId),
  true,
  'list should include the created agent by id',
);
assert.equal(
  fs.realpathSync(listPayload.storagePath),
  fs.realpathSync(globalAgentsDir),
  'default list should point at the sandboxed user-global Codex agent directory',
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
const updatedContent = fs.readFileSync(createdAgentPath, 'utf8');
assert.match(
  updatedContent,
  /^name = "ops-helper"\ndescription = ""\nmodel = "inherit"\ntools = \[\]\n\nprompt = """\n# Ops Helper\n\nUpdated instructions\./m,
  'update should preserve required TOML fields when overwriting content',
);

const defaultListPayload = await (await request('/api/agent-definitions')).json();
assert.equal(
  defaultListPayload.agents.some((agent) => agent.id === 'global-helper'),
  true,
  'default shipped behavior should read user-global Codex agents from the sandbox home',
);

const memberListResponse = await request(
  '/api/agent-definitions',
  {},
  'member-session-token',
);
assert.equal(
  memberListResponse.status,
  403,
  'non-system-config users should not be able to enumerate the operator agent directory',
);

const agentDefinitionsPage = fs.readFileSync(
  path.join(repoRoot, 'web', 'src', 'pages', 'AgentDefinitionsPage.tsx'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.join(repoRoot, 'web', 'src', 'App.tsx'),
  'utf8',
);
const settingsPageSource = fs.readFileSync(
  path.join(repoRoot, 'web', 'src', 'pages', 'SettingsPage.tsx'),
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
  /默认直接读写/u,
  'settings surface should explain that default behavior writes directly to the global Codex agent directory',
);
assert.match(
  agentDefinitionsPage,
  /临时 HOME 沙箱/u,
  'settings surface should mention sandboxed validation guidance for the default-global path',
);
assert.doesNotMatch(
  agentDefinitionsPage,
  /Droid|subagent_type/u,
  'settings surface should not ship Droid-branded or Task guidance copy',
);
assert.doesNotMatch(
  agentDefinitionsPage,
  /Switch|globalModeEnabled|storageMode === 'global'|工作区目录|用户全局 Agent 目录/u,
  'settings surface should not ship a storage-mode toggle or project-local default copy',
);
assert.match(
  appSource,
  /path="\/agent-definitions"[\s\S]*?<AuthGuard requiredPermission="manage_system_config">[\s\S]*?<AgentDefinitionsPage \/>[\s\S]*?<\/AuthGuard>/u,
  'standalone /agent-definitions route should be guarded by manage_system_config on the frontend',
);
assert.match(
  settingsPageSource,
  /const SYSTEM_CONFIG_ONLY_TABS: SettingsTab\[\] = \['agent-definitions'\]/u,
  'settings page should mark agent-definitions as a privileged-only tab',
);
assert.match(
  settingsPageSource,
  /SYSTEM_CONFIG_ONLY_TABS\.includes\(raw\) && !canManageSystemConfig/u,
  'settings page should redirect unauthorized tab query access back to a safe default tab',
);
assert.match(
  settingsPageSource,
  /setSearchParams\(\{ tab: activeTab \}, \{ replace: true \}\)/u,
  'settings page should normalize unauthorized agent-definitions tab queries back to the resolved safe tab in the URL',
);

console.log('✅ agent-definition-surface-cleanup assertions passed');
fs.rmSync(tempRoot, { recursive: true, force: true });
fs.rmSync(tempHome, { recursive: true, force: true });
process.exit(0);

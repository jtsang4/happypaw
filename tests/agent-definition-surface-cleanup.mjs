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
const expectedFilePath = path.join(
  tempHome,
  '.factory',
  'droids',
  `${agentId}.md`,
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

assert.ok(fs.existsSync(expectedFilePath), 'create should write the stored file');
const createdContent = fs.readFileSync(expectedFilePath, 'utf8');
assert.match(
  createdContent,
  /^---\nname: ops-helper\ndescription: \nmodel: inherit\n---\n\n# Ops Helper/m,
  'create should inject compatible frontmatter for stored definitions',
);

const listResponse = await request('/api/agent-definitions');
assert.equal(listResponse.status, 200, 'list should succeed');
const listPayload = await listResponse.json();
assert.equal(listPayload.agents.length, 1, 'list should include the created definition');
assert.equal(listPayload.agents[0].id, agentId);
assert.equal(listPayload.agents[0].name, agentId);

const detailResponse = await request(`/api/agent-definitions/${agentId}`);
assert.equal(detailResponse.status, 200, 'detail should succeed');
const detailPayload = await detailResponse.json();
assert.equal(detailPayload.agent.id, agentId);
assert.match(
  detailPayload.agent.content,
  /model: inherit/u,
  'detail should preserve injected frontmatter',
);

const updateResponse = await request(`/api/agent-definitions/${agentId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: updatedBody }),
});
assert.equal(updateResponse.status, 200, 'update should succeed');
const updatedContent = fs.readFileSync(expectedFilePath, 'utf8');
assert.match(
  updatedContent,
  /^---\nname: ops-helper\ndescription: \nmodel: inherit\n---\n\n# Ops Helper\n\nUpdated instructions\./m,
  'update should preserve required frontmatter when overwriting content',
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
  /\.factory\/droids\/\*\.md/u,
  'settings surface may mention the implementation storage path',
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

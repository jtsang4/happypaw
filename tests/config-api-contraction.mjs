#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happypaw-config-api-'));

process.chdir(tempRoot);
process.env.OPENAI_BASE_URL = 'https://env.example.com/v1';
process.env.OPENAI_API_KEY = 'env-api-key';
process.env.OPENAI_MODEL = 'env-model';

const [
  { Hono },
  configRoutesModule,
  codexRoutesModule,
  legacySystemRoutesModule,
  userImRoutesModule,
  userImWeChatBindingsRoutesModule,
  runtimeConfigModule,
  authRoutesModule,
  dbCoreModule,
  dbSharedModule,
  dbUsersAuthModule,
  authHelpersModule,
  configModule,
] = await Promise.all([
  import('hono'),
  import(path.join(repoRoot, 'dist', 'routes', 'config.js')),
  import(path.join(repoRoot, 'dist', 'routes', 'config', 'codex-routes.js')),
  import(
    path.join(repoRoot, 'dist', 'routes', 'config', 'legacy-system-routes.js')
  ),
  import(path.join(repoRoot, 'dist', 'routes', 'config', 'user-im-routes.js')),
  import(
    path.join(
      repoRoot,
      'dist',
      'routes',
      'config',
      'user-im-wechat-bindings-routes.js',
    )
  ),
  import(path.join(repoRoot, 'dist', 'runtime-config.js')),
  import(path.join(repoRoot, 'dist', 'routes', 'auth.js')),
  import(path.join(repoRoot, 'dist', 'db', 'core.js')),
  import(path.join(repoRoot, 'dist', 'db', 'shared.js')),
  import(path.join(repoRoot, 'dist', 'db', 'users-auth.js')),
  import(path.join(repoRoot, 'dist', 'auth.js')),
  import(path.join(repoRoot, 'dist', 'config.js')),
]);

assert.ok(
  configRoutesModule?.default,
  'built config route composition should be importable standalone',
);
await import(path.join(repoRoot, 'dist', 'web.js'));
const groupRoutes = (await import(path.join(repoRoot, 'dist', 'routes', 'groups.js'))).default;
const { registerCodexRoutes } = codexRoutesModule;
const { registerLegacyAndSystemRoutes } = legacySystemRoutesModule;
const { registerUserImRoutes } = userImRoutesModule;
const { registerUserImWeChatAndBindingRoutes } =
  userImWeChatBindingsRoutesModule;
const { saveCodexProviderConfig, saveCodexProviderSecrets } = runtimeConfigModule;
const { authMiddleware } = await import(
  path.join(repoRoot, 'dist', 'middleware', 'auth.js')
);
const { setSessionCookieHeaders } = authRoutesModule;
const { setDatabaseInstance } = dbSharedModule;
const { createUser, createUserSession } = dbUsersAuthModule;
const { hashPassword, sessionExpiresAt } = authHelpersModule;
const { STORE_DIR } = configModule;
const { ensureChatExists } = await import(path.join(repoRoot, 'dist', 'db.js'));

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
app.use('*', authMiddleware);
app.route('/api/groups', groupRoutes);
registerCodexRoutes(app);
registerLegacyAndSystemRoutes(app);
registerUserImRoutes(app);
registerUserImWeChatAndBindingRoutes(app);

const cookieHeaders = setSessionCookieHeaders(
  { req: { header: () => undefined, url: 'http://localhost/api/config/codex' } },
  'session-token',
);
const cookie = cookieHeaders.getSetCookie()[0].split(';')[0];

// Stub auth by calling the pure runtime helpers directly to verify the contracted payload shape.
saveCodexProviderConfig({
  openaiBaseUrl: 'https://runtime.example.com/v1',
  openaiModel: 'gpt-5.1-mini',
});
saveCodexProviderSecrets({
  openaiApiKey: 'runtime-secret-key',
});

const { getCodexProviderConfigWithSource, toPublicCodexProviderConfig } =
  runtimeConfigModule;
const { config, source } = getCodexProviderConfigWithSource();
const publicPayload = toPublicCodexProviderConfig(config, source);

assert.equal(publicPayload.source, 'runtime');
assert.equal(publicPayload.hasOpenaiBaseUrl, true);
assert.equal(publicPayload.hasOpenaiApiKey, true);
assert.equal(publicPayload.openaiModel, 'gpt-5.1-mini');
assert.match(
  publicPayload.openaiBaseUrlMasked ?? '',
  /^https:\/\/.*\/\*\*\*$/,
  'base URL should be masked in public payloads',
);
assert.notEqual(
  publicPayload.openaiApiKeyMasked,
  'runtime-secret-key',
  'API key should never be returned in clear text',
);
assert.match(
  publicPayload.openaiApiKeyMasked ?? '',
  /\*/,
  'API key mask should contain masking characters',
);

const routePaths = app.routes.map((route) => route.path);
assert.ok(routePaths.includes('/codex'));
assert.ok(routePaths.includes('/codex/secrets'));
assert.ok(
  !routePaths.includes('/claude'),
  'contracted config routes should not register legacy /claude endpoint',
);
assert.ok(
  !routePaths.some((route) => route.startsWith('/claude/')),
  'contracted config routes should not register any /claude/* endpoints',
);

const codexResponse = await app.request('/codex', {
  headers: { Cookie: cookie },
});
assert.equal(codexResponse.status, 200);
const codexPayload = await codexResponse.json();
assert.equal(codexPayload.hasOpenaiApiKey, true);
assert.equal(codexPayload.openaiApiKeyMasked, publicPayload.openaiApiKeyMasked);

const secretsResponse = await app.request('/codex/secrets', {
  method: 'PUT',
  headers: {
    Cookie: cookie,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ openaiApiKey: 'rotated-secret-key' }),
});
assert.equal(secretsResponse.status, 200);
const secretsPayload = await secretsResponse.json();
assert.equal(secretsPayload.hasOpenaiApiKey, true);
assert.notEqual(
  secretsPayload.openaiApiKeyMasked,
  'rotated-secret-key',
  'secret update responses must stay masked',
);

const clearedBaseUrlResponse = await app.request('/codex', {
  method: 'PUT',
  headers: {
    Cookie: cookie,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ openaiBaseUrl: '' }),
});
assert.equal(clearedBaseUrlResponse.status, 200);
const clearedBaseUrlPayload = await clearedBaseUrlResponse.json();
assert.equal(
  clearedBaseUrlPayload.hasOpenaiBaseUrl,
  true,
  'effective payload should still report a base URL when env/default fallback is available',
);
assert.equal(
  clearedBaseUrlPayload.source,
  'runtime',
  'runtime source remains selected while other runtime overrides still exist',
);

const runtimeCodexConfigFile = path.join(
  tempRoot,
  'data',
  'config',
  'codex-provider.json',
);
const runtimeCodexConfig = JSON.parse(
  fs.readFileSync(runtimeCodexConfigFile, 'utf8'),
);
assert.equal(
  runtimeCodexConfig.openaiBaseUrl,
  '',
  'blank openaiBaseUrl submissions should clear the stored runtime override',
);

const legacyResponse = await app.request('/claude', {
  headers: { Cookie: cookie },
});
assert.equal(
  legacyResponse.status,
  404,
  'legacy Claude config endpoint should be absent from the composed config routes',
);

const tempWorkspaceFolder = 'env-contraction-workspace';
const tempWorkspaceJid = 'web:env-contraction';
dbSharedModule.db
  .prepare('DELETE FROM registered_groups WHERE jid = ?')
  .run(tempWorkspaceJid);
dbSharedModule.db
  .prepare('DELETE FROM chats WHERE jid = ?')
  .run(tempWorkspaceJid);
ensureChatExists(tempWorkspaceJid);
dbSharedModule.db
  .prepare(
    `INSERT INTO registered_groups (jid, name, folder, added_at, container_config, execution_mode, runtime, custom_cwd, init_source_path, init_git_url, created_by, is_home, selected_skills, target_agent_id, target_main_jid, reply_policy, require_mention, activation_mode, mcp_mode, selected_mcps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    tempWorkspaceJid,
    'Env Contraction Workspace',
    tempWorkspaceFolder,
    new Date().toISOString(),
    null,
    'container',
    null,
    null,
    null,
    null,
    'admin-user',
    0,
    null,
    null,
    null,
    'source_only',
    0,
    'auto',
    'inherit',
    null,
  );

const workspaceEnvResponse = await app.request(
  `/api/groups/${encodeURIComponent(tempWorkspaceJid)}/env`,
  {
    headers: { Cookie: cookie },
  },
);
assert.equal(workspaceEnvResponse.status, 200);
const workspaceEnvPayload = await workspaceEnvResponse.json();
assert.deepEqual(workspaceEnvPayload, { customEnv: {} });
for (const forbiddenKey of [
  'anthropicBaseUrl',
  'anthropicAuthTokenMasked',
  'anthropicApiKeyMasked',
  'claudeCodeOauthTokenMasked',
  'hasAnthropicAuthToken',
  'hasAnthropicApiKey',
  'hasClaudeCodeOauthToken',
  'anthropicModel',
]) {
  assert.ok(
    !(forbiddenKey in workspaceEnvPayload),
    `workspace env payload should not expose ${forbiddenKey}`,
  );
}

const rejectedLegacyEnvResponse = await app.request(
  `/api/groups/${encodeURIComponent(tempWorkspaceJid)}/env`,
  {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      anthropicBaseUrl: 'https://legacy.example.com',
      customEnv: { SAFE_FLAG: '1' },
    }),
  },
);
assert.equal(
  rejectedLegacyEnvResponse.status,
  400,
  'workspace env route should reject legacy Claude-shaped fields',
);

const updatedWorkspaceEnvResponse = await app.request(
  `/api/groups/${encodeURIComponent(tempWorkspaceJid)}/env`,
  {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      customEnv: { SAFE_FLAG: '1', OPENAI_BASE_URL: 'https://custom.example/v1' },
    }),
  },
);
assert.equal(updatedWorkspaceEnvResponse.status, 200);
const updatedWorkspaceEnvPayload = await updatedWorkspaceEnvResponse.json();
assert.deepEqual(updatedWorkspaceEnvPayload, {
  customEnv: {
    SAFE_FLAG: '1',
    OPENAI_BASE_URL: 'https://custom.example/v1',
  },
});

dbCoreModule.closeDatabase();

console.log('✅ config API contraction checks passed');
process.exit(0);

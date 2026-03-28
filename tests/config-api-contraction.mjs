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

const legacyResponse = await app.request('/claude', {
  headers: { Cookie: cookie },
});
assert.equal(
  legacyResponse.status,
  404,
  'legacy Claude config endpoint should be absent from the composed config routes',
);

dbCoreModule.closeDatabase();

console.log('✅ config API contraction checks passed');
process.exit(0);

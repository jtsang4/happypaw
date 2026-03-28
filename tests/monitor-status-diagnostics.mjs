#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happypaw-monitor-status-'));
const fakeBinDir = path.join(tempRoot, 'bin');

process.chdir(tempRoot);
process.env.OPENAI_API_KEY = 'env-api-key';
process.env.OPENAI_BASE_URL = 'https://env.example.com/v1';
process.env.OPENAI_MODEL = 'gpt-5.1-mini';
fs.mkdirSync(fakeBinDir, { recursive: true });
fs.writeFileSync(
  path.join(fakeBinDir, 'docker'),
  `#!/bin/sh
if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$3" = "happypaw-agent:latest" ]; then
  echo '[{"Id":"sha256:test-image"}]'
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 1
`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(fakeBinDir, 'gh'),
  `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
  { mode: 0o755 },
);
process.env.PATH = `${fakeBinDir}:${process.env.PATH}`;

const [
  { Hono },
  monitorRoutesModule,
  authRoutesModule,
  dbCoreModule,
  dbSharedModule,
  dbUsersAuthModule,
  authHelpersModule,
  configModule,
  webContextModule,
  runtimeConfigModule,
] = await Promise.all([
  import('hono'),
  import(path.join(repoRoot, 'dist', 'routes', 'monitor.js')),
  import(path.join(repoRoot, 'dist', 'routes', 'auth.js')),
  import(path.join(repoRoot, 'dist', 'db', 'core.js')),
  import(path.join(repoRoot, 'dist', 'db', 'shared.js')),
  import(path.join(repoRoot, 'dist', 'db', 'users-auth.js')),
  import(path.join(repoRoot, 'dist', 'auth.js')),
  import(path.join(repoRoot, 'dist', 'config.js')),
  import(path.join(repoRoot, 'dist', 'web-context.js')),
  import(path.join(repoRoot, 'dist', 'runtime-config.js')),
]);

const monitorRoutes = monitorRoutesModule.default;
const { setSessionCookieHeaders } = authRoutesModule;
const { setDatabaseInstance } = dbSharedModule;
const { createUser, createUserSession } = dbUsersAuthModule;
const { hashPassword, sessionExpiresAt } = authHelpersModule;
const { STORE_DIR } = configModule;
const { setWebDeps } = webContextModule;
const { saveCodexProviderConfig, saveCodexProviderSecrets } = runtimeConfigModule;

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

setWebDeps({
  queue: {
    getStatus: () => ({
      activeCount: 2,
      activeContainerCount: 1,
      activeHostProcessCount: 1,
      waitingCount: 1,
      waitingGroupJids: ['web:monitor-home'],
      groups: [
        {
          jid: 'web:monitor-home',
          active: true,
          pendingMessages: true,
          pendingTasks: 1,
          containerName: 'monitor-home',
          displayName: 'Monitor Home',
        },
      ],
    }),
  },
});

const app = new Hono();
app.route('/api', monitorRoutes);

const cookieHeaders = setSessionCookieHeaders(
  { req: { header: () => undefined, url: 'http://localhost/api/status' } },
  'session-token',
);
const cookie = cookieHeaders.getSetCookie()[0].split(';')[0];

const statusResponse = await app.request('/api/status', {
  headers: {
    Cookie: cookie,
  },
});
assert.equal(statusResponse.status, 200, 'status endpoint should succeed for admin');

const payload = await statusResponse.json();
assert.equal(
  'claudeCodeVersions' in payload,
  false,
  'status payload should not expose claudeCodeVersions',
);
assert.ok(payload.codexDiagnostics, 'status payload should include codexDiagnostics');
assert.equal(
  payload.dockerImageExists,
  true,
  'status payload should report the pinned container image as available when docker inspect succeeds',
);
assert.equal(payload.codexDiagnostics.pinnedVersion, '0.116.0');
assert.match(
  payload.codexDiagnostics.releaseSource,
  /GitHub Releases/u,
  'release source should explain the pinned Codex source',
);
assert.equal(payload.codexDiagnostics.helperReadiness.taskParsing.ready, true);
assert.equal(payload.codexDiagnostics.helperReadiness.bugReportGeneration.ready, true);
assert.equal(
  typeof payload.codexDiagnostics.helperReadiness.githubIssueSubmission.ready,
  'boolean',
  'GitHub submission readiness should be surfaced explicitly',
);
assert.match(
  payload.codexDiagnostics.containerBundle.executablePath,
  /\/opt\/happypaw\/bin\/codex/u,
  'container diagnostics should point at the bundled pinned Codex path',
);
assert.equal(
  payload.codexDiagnostics.containerBundle.imageReady,
  true,
  'container diagnostics should stay ready even when no container-mode groups currently exist',
);

const monitorPageSource = fs.readFileSync(
  path.join(repoRoot, 'web', 'src', 'pages', 'MonitorPage.tsx'),
  'utf8',
);
assert.doesNotMatch(
  monitorPageSource,
  /Claude Code SDK\/CLI/u,
  'monitor page build messaging should no longer mention Claude Code',
);

const monitorSystemInfoSource = fs.readFileSync(
  path.join(repoRoot, 'web', 'src', 'components', 'monitor', 'SystemInfo.tsx'),
  'utf8',
);
assert.match(
  monitorSystemInfoSource,
  /固定 Codex/u,
  'monitor system info should present pinned Codex diagnostics',
);
assert.match(
  monitorSystemInfoSource,
  /任务解析助手/u,
  'monitor system info should expose helper readiness details',
);
assert.doesNotMatch(
  monitorSystemInfoSource,
  /Claude Code/u,
  'monitor system info should not mention Claude Code',
);

console.log('✅ monitor-status-diagnostics assertions passed');
process.exit(0);

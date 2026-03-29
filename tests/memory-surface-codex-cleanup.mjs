#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const schemasSource = read('src/schemas.ts');
assert.match(
  schemasSource,
  /kind:\s*'primary' \| 'note' \| 'session'/u,
  'MemorySource schema should expose Codex-neutral primary memory kinds',
);
assert.doesNotMatch(
  schemasSource,
  /kind:\s*'claude' \| 'note' \| 'session'/u,
  'MemorySource schema should not expose Claude-branded kinds',
);

const memoryRouteSource = read('src/routes/memory.ts');
assert.match(
  memoryRouteSource,
  /kind:\s*'primary'/u,
  'Memory source classification should tag primary memory files with a neutral kind',
);
assert.doesNotMatch(
  memoryRouteSource,
  /kind:\s*'claude'/u,
  'Memory source classification should not emit Claude kinds',
);
assert.match(
  memoryRouteSource,
  /const kindRank:[\s\S]*primary:\s*0/u,
  'Memory source ordering should continue to prioritize primary memory files first',
);
assert.match(
  memoryRouteSource,
  /label:\s*'主会话主记忆'/u,
  'Main workspace memory should expose a neutral primary-memory label',
);
assert.match(
  memoryRouteSource,
  /全局主记忆/u,
  'User-global primary memory should expose a neutral primary-memory label',
);
assert.match(
  memoryRouteSource,
  /const MEMORY_LOCATOR_PREFIX = 'memory:\/\/'/u,
  'Memory routes should expose a public memory locator contract',
);
assert.match(
  memoryRouteSource,
  /locator:\s*toPublicLocator\(normalized\)/u,
  'Memory file payloads should emit public locators instead of raw paths',
);
assert.match(
  memoryRouteSource,
  /c\.req\.query\('locator'\) \?\? c\.req\.query\('path'\)/u,
  'Memory file reads should accept the new locator contract while keeping legacy path compatibility',
);
assert.match(
  memoryRouteSource,
  /validation\.data\.locator \?\? validation\.data\.path/u,
  'Memory file writes should accept the new locator contract while keeping legacy path compatibility',
);
assert.doesNotMatch(
  memoryRouteSource,
  /label:\s*`会话自动记忆/u,
  'Session memory labels should no longer use the generic session-memory wording',
);

const memoryPageSource = read('web/src/pages/MemoryPage.tsx');
assert.match(
  memoryPageSource,
  /kind:\s*'primary' \| 'note' \| 'session'/u,
  'Memory page types should use the neutral primary memory kind',
);
assert.doesNotMatch(
  memoryPageSource,
  /kind:\s*'claude' \| 'note' \| 'session'/u,
  'Memory page should not type against Claude-branded memory kinds',
);
assert.match(
  memoryPageSource,
  /scope === 'user-global' && s\.kind === 'primary'/u,
  'Memory page default selection should still prefer user-global primary memory',
);
assert.match(
  memoryPageSource,
  /scope === 'main' && s\.kind === 'primary'/u,
  'Memory page default selection should still prefer main primary memory next',
);
assert.match(
  memoryPageSource,
  /locator:\s*string;/u,
  'Memory page types should consume public locators',
);
assert.doesNotMatch(
  memoryPageSource,
  /path:\s*string;/u,
  'Memory page types should not depend on raw path fields',
);
assert.match(
  memoryPageSource,
  /new URLSearchParams\(\{ locator \}\)/u,
  'Memory page should request files by public locator',
);
assert.match(
  memoryPageSource,
  /searchHits\[source\.locator\]/u,
  'Memory page should key search hits by public locator',
);
assert.match(
  memoryPageSource,
  /function sanitizeVisibleMemoryText\(text: string\)/u,
  'Memory page should sanitize browser-visible locator and legacy wording',
);
assert.match(
  memoryPageSource,
  /记忆源/u,
  'Memory page sanitization should mask raw public locators from the browser surface',
);
assert.match(
  memoryPageSource,
  /AGENTS\\\.md/u,
  'Memory page sanitization should mask AGENTS.md wording from visible snippets',
);
assert.match(
  memoryPageSource,
  /\\.codex/iu,
  'Memory page sanitization should mask .codex wording from visible snippets',
);
assert.match(
  memoryPageSource,
  /sanitizeVisibleMemoryText\(source\.label\)/u,
  'Memory page source rows should render sanitized labels',
);
assert.match(
  memoryPageSource,
  /sanitizeVisibleMemoryText\(hit\.snippet\)/u,
  'Memory page search-hit snippets should render sanitized text',
);
assert.match(
  memoryPageSource,
  /sanitizeVisibleMemoryText\(selectedSource\.label\)/u,
  'Memory page selected-file header should render sanitized text',
);
assert.match(
  memoryPageSource,
  /\{scopeLabel\(source\.scope\)\} · \{kindLabel\(source\.kind\)\}/u,
  'Memory page source rows should render neutral scope and kind metadata instead of raw locators',
);
assert.match(
  memoryPageSource,
  /\{scopeLabel\(selectedSource\.scope\)\} · \{kindLabel\(selectedSource\.kind\)\}/u,
  'Memory page selected-file header should render neutral scope and kind metadata',
);

const readmeSource = read('README.md');
assert.doesNotMatch(
  readmeSource,
  /CLAUDE\.md/u,
  'README should not advertise Claude-branded memory files on supported surfaces',
);

const makefileSource = read('Makefile');
assert.doesNotMatch(
  makefileSource,
  /claude-agent-sdk/u,
  'Makefile should not advertise Claude SDK maintenance commands on shipped surfaces',
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happypaw-memory-api-'));
process.chdir(tempRoot);

const [
  { Hono },
  memoryRoutesModule,
  authMiddlewareModule,
  authRoutesModule,
  dbCoreModule,
  dbSharedModule,
  dbGroupsModule,
  dbUsersAuthModule,
  authHelpersModule,
  configModule,
] = await Promise.all([
  import('hono'),
  import(path.join(repoRoot, 'dist', 'routes', 'memory.js')),
  import(path.join(repoRoot, 'dist', 'middleware', 'auth.js')),
  import(path.join(repoRoot, 'dist', 'routes', 'auth.js')),
  import(path.join(repoRoot, 'dist', 'db', 'core.js')),
  import(path.join(repoRoot, 'dist', 'db', 'shared.js')),
  import(path.join(repoRoot, 'dist', 'db', 'groups.js')),
  import(path.join(repoRoot, 'dist', 'db', 'users-auth.js')),
  import(path.join(repoRoot, 'dist', 'auth.js')),
  import(path.join(repoRoot, 'dist', 'config.js')),
]);

const { STORE_DIR } = configModule;
fs.mkdirSync(STORE_DIR, { recursive: true });
dbSharedModule.setDatabaseInstance(
  new Database(path.join(STORE_DIR, 'messages.db')),
);
dbCoreModule.initDatabase();

const passwordHash = await authHelpersModule.hashPassword('password123');
dbUsersAuthModule.createUser({
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
dbUsersAuthModule.createUserSession({
  id: 'session-token',
  user_id: 'admin-user',
  ip_address: '127.0.0.1',
  user_agent: 'memory-test',
  created_at: new Date().toISOString(),
  expires_at: authHelpersModule.sessionExpiresAt(),
  last_active_at: new Date().toISOString(),
});

const now = new Date().toISOString();
dbGroupsModule.setRegisteredGroup('web:main', {
  name: 'Main',
  folder: 'main',
  added_at: now,
  executionMode: 'host',
  created_by: 'admin-user',
  is_home: true,
});
dbGroupsModule.setRegisteredGroup('web:flow-demo', {
  name: 'Flow Demo',
  folder: 'flow-demo',
  added_at: now,
  executionMode: 'container',
  created_by: 'admin-user',
  is_home: false,
});

fs.mkdirSync(path.join(tempRoot, 'data', 'groups', 'user-global', 'admin-user'), {
  recursive: true,
});
fs.mkdirSync(path.join(tempRoot, 'data', 'groups', 'main'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'data', 'groups', 'flow-demo'), {
  recursive: true,
});
fs.mkdirSync(path.join(tempRoot, 'data', 'memory', 'flow-demo'), {
  recursive: true,
});
fs.mkdirSync(path.join(tempRoot, 'data', 'sessions', 'main', '.codex'), {
  recursive: true,
});

fs.writeFileSync(
  path.join(tempRoot, 'data', 'groups', 'user-global', 'admin-user', 'AGENTS.md'),
  'global preference',
);
fs.writeFileSync(
  path.join(tempRoot, 'data', 'groups', 'main', 'AGENTS.md'),
  'main preference',
);
fs.writeFileSync(
  path.join(tempRoot, 'data', 'groups', 'flow-demo', 'notes.md'),
  'flow notes',
);
fs.writeFileSync(
  path.join(tempRoot, 'data', 'memory', 'flow-demo', '2026-03-29.md'),
  'workspace timeline entry',
);
fs.writeFileSync(
  path.join(tempRoot, 'data', 'sessions', 'main', '.codex', 'settings.json'),
  '{"memory":"session"}',
);

const app = new Hono();
app.use('*', authMiddlewareModule.authMiddleware);
app.route('/api/memory', memoryRoutesModule.default);

const cookieHeaders = authRoutesModule.setSessionCookieHeaders(
  {
    req: { header: () => undefined, url: 'http://localhost/api/memory/sources' },
  },
  'session-token',
);
const cookie = cookieHeaders.getSetCookie()[0].split(';')[0];

const sourcesResponse = await app.request('/api/memory/sources', {
  headers: { Cookie: cookie },
});
assert.equal(sourcesResponse.status, 200, 'Memory sources endpoint should respond successfully');
const sourcesPayload = await sourcesResponse.json();
assert.ok(Array.isArray(sourcesPayload.sources), 'Memory sources payload should include a sources array');
assert.ok(
  sourcesPayload.sources.every((source) => typeof source.locator === 'string'),
  'Memory sources should expose locators',
);
assert.ok(
  sourcesPayload.sources.every((source) => !Object.hasOwn(source, 'path')),
  'Memory sources should not expose raw path fields',
);
assert.ok(
  sourcesPayload.sources.every(
    (source) =>
      !/AGENTS\.md|\.codex/u.test(`${source.locator} ${source.label}`),
  ),
  'Memory sources should not emit raw runtime paths on supported surfaces',
);

const globalSource = sourcesPayload.sources.find(
  (source) => source.scope === 'user-global' && source.kind === 'primary',
);
assert.ok(globalSource, 'Memory sources should include the user-global primary memory');
assert.equal(
  globalSource.locator,
  'memory://user-global/admin-user/primary',
  'User-global primary memory should use the public locator contract',
);

const sessionSource = sourcesPayload.sources.find(
  (source) => source.scope === 'session',
);
assert.ok(sessionSource, 'Memory sources should include session memory entries');
assert.match(
  sessionSource.label,
  /自动记忆/u,
  'Session memory should use the neutral automatic-memory label',
);
assert.doesNotMatch(
  sessionSource.label,
  /\.codex/u,
  'Session memory labels should not expose .codex paths',
);

const fileResponse = await app.request(
  `/api/memory/file?${new URLSearchParams({ locator: globalSource.locator })}`,
  {
    headers: { Cookie: cookie },
  },
);
assert.equal(fileResponse.status, 200, 'Memory file reads should accept locators');
const filePayload = await fileResponse.json();
assert.equal(
  filePayload.locator,
  globalSource.locator,
  'Memory file reads should echo the public locator',
);
assert.ok(
  !Object.hasOwn(filePayload, 'path'),
  'Memory file payloads should not expose raw path fields',
);

const primaryFileResponse = await app.request(
  `/api/memory/file?${new URLSearchParams({ path: 'data/groups/main/AGENTS.md' })}`,
  {
    headers: { Cookie: cookie },
  },
);
assert.equal(
  primaryFileResponse.status,
  200,
  'Memory file reads should accept AGENTS.md primary paths',
);
const primaryFilePayload = await primaryFileResponse.json();
assert.equal(
  primaryFilePayload.locator,
  'memory://workspace/main/primary',
  'Primary path reads should emit the public locator contract',
);

const searchResponse = await app.request(
  `/api/memory/search?${new URLSearchParams({ q: 'timeline', limit: '20' })}`,
  {
    headers: { Cookie: cookie },
  },
);
assert.equal(searchResponse.status, 200, 'Memory search should respond successfully');
const searchPayload = await searchResponse.json();
assert.ok(searchPayload.hits.length >= 1, 'Memory search should return hits for matching content');
assert.ok(
  searchPayload.hits.every((hit) => typeof hit.locator === 'string' && !Object.hasOwn(hit, 'path')),
  'Memory search hits should expose public locators only',
);
assert.ok(
  searchPayload.hits.every(
    (hit) => !/AGENTS\.md|\.codex/u.test(`${hit.locator} ${hit.label ?? ''}`),
  ),
  'Memory search hits should not expose raw runtime paths',
);

const writeResponse = await app.request('/api/memory/file', {
  method: 'PUT',
  headers: {
    Cookie: cookie,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    path: 'data/groups/flow-demo/AGENTS.md',
    content: 'updated flow memory',
  }),
});
assert.equal(
  writeResponse.status,
  200,
  'Memory writes should accept AGENTS.md primary paths',
);
const writePayload = await writeResponse.json();
assert.equal(
  writePayload.locator,
  'memory://workspace/flow-demo/primary',
  'Primary path writes should emit the public locator contract',
);

const packageSource = JSON.parse(read('package.json'));
assert.deepEqual(
  packageSource.keywords.includes('claude'),
  false,
  'package keywords should not advertise Claude support',
);
assert.deepEqual(
  packageSource.keywords.includes('claude-code'),
  false,
  'package keywords should not advertise claude-code support',
);
assert.deepEqual(
  packageSource.keywords.includes('codex'),
  true,
  'package keywords should advertise Codex support',
);

console.log('✅ memory-surface-codex-cleanup assertions passed');

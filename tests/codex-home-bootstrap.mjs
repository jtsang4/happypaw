#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happypaw-codex-home-'));

process.chdir(tempRoot);
process.env.OPENAI_BASE_URL = 'https://codex.example.com/v1';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.OPENAI_MODEL = 'gpt-5.1-codex';

const runtimeConfigModule = await import(
  path.join(repoRoot, 'dist', 'runtime-config.js')
);
const codexConfigModule = await import(
  path.join(repoRoot, 'dist', 'codex-config.js')
);
const dbModule = await import(path.join(repoRoot, 'dist', 'db.js'));

const {
  getClaudeProviderConfig,
  getCodexProviderConfig,
  buildClaudeEnvLines,
  createProvider,
  getEnabledProviders,
  buildContainerEnvLines,
  getContainerEnvConfig,
  saveOfficialCustomEnv,
  saveContainerEnvConfig,
  shellQuoteEnvLines,
  updateProvider,
} = runtimeConfigModule;
const {
  INTERNAL_MCP_BRIDGE_ID,
  CURRENT_PRODUCT_ID,
  LEGACY_PRODUCT_ID,
  toLegacyProductEnvToken,
} = await import(path.join(repoRoot, 'dist', 'legacy-product.js'));
const {
  prepareCodexHome,
  readCodexMcpServersFromSettings,
  mergeCodexMcpServers,
} = codexConfigModule;
const {
  ensurePinnedCodexHostBinary,
  getPinnedCodexContainerExecutablePath,
  getPinnedCodexRepoCacheRoot,
  HAPPYPAW_CODEX_EXECUTABLE_ENV,
} = await import(path.join(repoRoot, 'dist', 'codex-binary.js'));
const { initDatabase, closeDatabase, setSession, getRuntimeSession, getAllSessions } =
  dbModule;

const workspaceDir = path.join(tempRoot, 'workspace');
const workspaceClaudeDir = path.join(workspaceDir, '.claude');
const codexHome = path.join(tempRoot, 'session-home', '.codex');
const userMcpDir = path.join(tempRoot, 'data', 'mcp-servers', 'u1');
fs.mkdirSync(workspaceClaudeDir, { recursive: true });
fs.mkdirSync(userMcpDir, { recursive: true });

fs.writeFileSync(
  path.join(workspaceClaudeDir, 'settings.json'),
  JSON.stringify(
    {
      mcpServers: {
        workspaceEnabled: {
          command: 'node',
          args: ['workspace-server.mjs'],
          env: { WORKSPACE_ONLY: '1' },
        },
        workspaceDisabled: {
          command: 'node',
          args: ['disabled.mjs'],
          enabled: false,
        },
        [CURRENT_PRODUCT_ID]: {
          command: 'node',
          args: ['shadow.mjs'],
        },
      },
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(userMcpDir, 'servers.json'),
  JSON.stringify(
    {
      servers: {
        userHttp: {
          type: 'http',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer abc' },
          enabled: true,
        },
        [LEGACY_PRODUCT_ID]: {
          command: 'node',
          args: ['legacy-shadow.mjs'],
          enabled: true,
        },
      },
    },
    null,
    2,
  ),
);

const providerConfig = getCodexProviderConfig();
const prepared = prepareCodexHome({
  codexHome,
  providerConfig,
  writableRoots: ['/workspace/group'],
  workspaceSettingsPath: path.join(workspaceClaudeDir, 'settings.json'),
  userSettingsPath: path.join(userMcpDir, 'servers.json'),
  bridge: {
    command: 'node',
    args: ['codex-mcp-bridge.mjs'],
    cwd: '/workspace/group',
    env: {
      HAPPYPAW_CHAT_JID: 'telegram:demo',
      HAPPYPAW_GROUP_FOLDER: 'demo',
      HAPPYPAW_WORKSPACE_GROUP: '/workspace/group',
      HAPPYPAW_WORKSPACE_GLOBAL: '/workspace/global',
      HAPPYPAW_WORKSPACE_MEMORY: '/workspace/memory',
      HAPPYPAW_WORKSPACE_IPC: '/workspace/ipc',
      HAPPYPAW_RUNTIME: 'codex_app_server',
      HAPPYPAW_OWNER_ID: 'u1',
      HAPPYPAW_PRODUCT_ID: CURRENT_PRODUCT_ID,
      HAPPYPAW_IS_HOME: '1',
      HAPPYPAW_IS_ADMIN_HOME: '0',
    },
  },
});

assert.ok(fs.existsSync(path.join(codexHome, 'config.toml')));
assert.ok(fs.existsSync(path.join(codexHome, 'sessions')));
assert.ok(fs.existsSync(path.join(codexHome, 'logs')));
assert.match(prepared.configToml, /model_provider = "happypaw_openai"/);
assert.match(prepared.configToml, /\[model_providers\.happypaw_openai\]/);
assert.match(prepared.configToml, /env_key = "OPENAI_API_KEY"/);
assert.match(
  prepared.configToml,
  /base_url = "https:\/\/codex\.example\.com\/v1"/,
);
assert.match(prepared.configToml, /sandbox_mode = "workspace-write"/);
assert.match(prepared.configToml, /\[mcp_servers\."workspaceEnabled"\]/);
assert.doesNotMatch(prepared.configToml, /workspaceDisabled/);
assert.match(prepared.configToml, /\[mcp_servers\."happypaw"\]/);
assert.match(prepared.configToml, /HAPPYPAW_GROUP_FOLDER = "demo"/);
assert.match(prepared.configToml, /HAPPYPAW_CHAT_JID = "telegram:demo"/);
assert.match(prepared.configToml, /HAPPYPAW_OWNER_ID = "u1"/);
assert.match(prepared.configToml, /HAPPYPAW_PRODUCT_ID = "happypaw"/);
assert.match(
  prepared.configToml,
  /HAPPYPAW_WORKSPACE_GLOBAL = "\/workspace\/global"/,
);
assert.match(
  prepared.configToml,
  /HAPPYPAW_WORKSPACE_MEMORY = "\/workspace\/memory"/,
);
assert.match(
  prepared.configToml,
  /HAPPYPAW_WORKSPACE_IPC = "\/workspace\/ipc"/,
);
assert.match(prepared.configToml, /command = "node"/);

const workspaceServers = readCodexMcpServersFromSettings(
  path.join(workspaceClaudeDir, 'settings.json'),
);
assert.deepEqual(Object.keys(workspaceServers).sort(), ['workspaceEnabled']);

const merged = mergeCodexMcpServers(
  readCodexMcpServersFromSettings(path.join(userMcpDir, 'servers.json')),
  workspaceServers,
  {
    command: 'node',
    args: ['bridge.mjs'],
    env: { HAPPYPAW_GROUP_FOLDER: 'demo' },
  },
);
assert.ok(merged.workspaceEnabled);
assert.ok(merged.userHttp);
assert.ok(merged[INTERNAL_MCP_BRIDGE_ID]);
assert.equal(merged[INTERNAL_MCP_BRIDGE_ID].command, 'node');
assert.equal(merged[LEGACY_PRODUCT_ID], undefined);

const legacyCodexExecutableEnv = toLegacyProductEnvToken(
  HAPPYPAW_CODEX_EXECUTABLE_ENV,
);
const createdProvider = createProvider({
  name: 'Pinned Provider',
  type: 'third_party',
  anthropicBaseUrl: 'https://provider.example.com',
  anthropicAuthToken: 'provider-secret-token',
  enabled: true,
  customEnv: {
    SAFE_PROVIDER_FLAG: '1',
    [HAPPYPAW_CODEX_EXECUTABLE_ENV]: '/tmp/provider-rogue-codex',
    [legacyCodexExecutableEnv]: '/tmp/provider-rogue-legacy-codex',
  },
});
assert.deepEqual(createdProvider.customEnv, {
  SAFE_PROVIDER_FLAG: '1',
});
const routeUpdatedProvider = updateProvider(getEnabledProviders()[0].id, {
  customEnv: {
    SAFE_PROVIDER_FLAG: '2',
    EXTRA_SAFE_FLAG: 'yes',
    [HAPPYPAW_CODEX_EXECUTABLE_ENV]: '/tmp/provider-route-rogue-codex',
    [legacyCodexExecutableEnv]: '/tmp/provider-route-rogue-legacy-codex',
  },
});
assert.deepEqual(routeUpdatedProvider.customEnv, {
  SAFE_PROVIDER_FLAG: '2',
  EXTRA_SAFE_FLAG: 'yes',
});
const activeProviderEnvLines = buildClaudeEnvLines(getClaudeProviderConfig());
assert.ok(activeProviderEnvLines.includes('SAFE_PROVIDER_FLAG=2'));
assert.ok(activeProviderEnvLines.includes('EXTRA_SAFE_FLAG=yes'));
assert.ok(
  !activeProviderEnvLines.some((line) =>
    line.startsWith(`${HAPPYPAW_CODEX_EXECUTABLE_ENV}=`),
  ),
);
assert.ok(
  !activeProviderEnvLines.some((line) =>
    line.startsWith(`${legacyCodexExecutableEnv}=`),
  ),
);
const explicitProviderEnvLines = buildClaudeEnvLines(
  getClaudeProviderConfig(),
  {
    SAFE_PROVIDER_FLAG: '3',
    [HAPPYPAW_CODEX_EXECUTABLE_ENV]: '/tmp/direct-rogue-codex',
    [legacyCodexExecutableEnv]: '/tmp/direct-rogue-legacy-codex',
  },
);
assert.ok(explicitProviderEnvLines.includes('SAFE_PROVIDER_FLAG=3'));
assert.ok(
  !explicitProviderEnvLines.some((line) =>
    line.startsWith(`${HAPPYPAW_CODEX_EXECUTABLE_ENV}=`),
  ),
);
assert.ok(
  !explicitProviderEnvLines.some((line) =>
    line.startsWith(`${legacyCodexExecutableEnv}=`),
  ),
);
const officialCustomEnv = saveOfficialCustomEnv({
  SAFE_OFFICIAL_FLAG: '1',
  [HAPPYPAW_CODEX_EXECUTABLE_ENV]: '/tmp/official-rogue-codex',
  [legacyCodexExecutableEnv]: '/tmp/official-rogue-legacy-codex',
});
assert.deepEqual(officialCustomEnv, {
  SAFE_OFFICIAL_FLAG: '1',
});
saveContainerEnvConfig('folder-env', {
  customEnv: {
    SAFE_FLAG: '1',
    [HAPPYPAW_CODEX_EXECUTABLE_ENV]: '/tmp/rogue-codex',
    [legacyCodexExecutableEnv]: '/tmp/rogue-legacy-codex',
  },
});
assert.deepEqual(getContainerEnvConfig('folder-env').customEnv, {
  SAFE_FLAG: '1',
});

const inheritedReservedEnvFolder = 'legacy-reserved-env';
const inheritedReservedEnvPath = path.join(
  tempRoot,
  'data',
  'config',
  'container-env',
  `${inheritedReservedEnvFolder}.json`,
);
fs.mkdirSync(path.dirname(inheritedReservedEnvPath), { recursive: true });
fs.writeFileSync(
  inheritedReservedEnvPath,
  JSON.stringify(
    {
      customEnv: {
        SAFE_FLAG: '1',
        [HAPPYPAW_CODEX_EXECUTABLE_ENV]: '/tmp/persisted-rogue-codex',
        [legacyCodexExecutableEnv]: '/tmp/persisted-rogue-legacy-codex',
      },
    },
    null,
    2,
  ),
);
const inheritedReservedEnv = getContainerEnvConfig(inheritedReservedEnvFolder);
assert.deepEqual(inheritedReservedEnv.customEnv, {
  SAFE_FLAG: '1',
});
const containerEnvLines = buildContainerEnvLines(
  getClaudeProviderConfig(),
  inheritedReservedEnv,
  undefined,
  providerConfig,
);
assert.ok(containerEnvLines.includes('SAFE_FLAG=1'));
assert.ok(
  !containerEnvLines.some((line) =>
    line.startsWith(`${HAPPYPAW_CODEX_EXECUTABLE_ENV}=`),
  ),
);
assert.ok(
  !containerEnvLines.some((line) =>
    line.startsWith(`${legacyCodexExecutableEnv}=`),
  ),
);
const quotedContainerEnv = shellQuoteEnvLines(containerEnvLines).join('\n');
assert.ok(!quotedContainerEnv.includes(HAPPYPAW_CODEX_EXECUTABLE_ENV));
assert.ok(!quotedContainerEnv.includes(legacyCodexExecutableEnv));

initDatabase();
setSession('folder-a', 'thread-123');
setSession('folder-a', 'agent-thread-456', 'agent-1');
assert.deepEqual(getRuntimeSession('folder-a'), {
  sessionId: 'thread-123',
});
assert.deepEqual(getRuntimeSession('folder-a', 'agent-1'), {
  sessionId: 'agent-thread-456',
});
assert.deepEqual(getAllSessions(), {
  'folder-a': { sessionId: 'thread-123' },
});
closeDatabase();

const hostCacheRoot = path.join(tempRoot, 'host-cache');
const downloadLog = [];
const pinnedBinaryFirst = ensurePinnedCodexHostBinary({
  cacheRoot: hostCacheRoot,
  downloadArchive: (_url, archivePath) => {
    downloadLog.push(archivePath);
    const fixtureArchive = path.join(tempRoot, 'fixture.tar.gz');
    const fixtureBinary = path.join(tempRoot, 'codex');
    fs.writeFileSync(fixtureBinary, '#!/bin/sh\necho pinned-codex\n', {
      mode: 0o755,
    });
    execFileSync('tar', ['-czf', fixtureArchive, '-C', tempRoot, 'codex']);
    fs.copyFileSync(fixtureArchive, archivePath);
  },
});
assert.equal(downloadLog.length, 1);
assert.equal(pinnedBinaryFirst.downloaded, true);
assert.ok(fs.existsSync(pinnedBinaryFirst.executablePath));
assert.match(pinnedBinaryFirst.assetName, /^codex-/);
assert.ok(
  pinnedBinaryFirst.executablePath.startsWith(hostCacheRoot),
  pinnedBinaryFirst.executablePath,
);
assert.ok(
  fs.existsSync(path.join(pinnedBinaryFirst.cacheDir, 'metadata.json')),
);
const hostEnv = {
  [HAPPYPAW_CODEX_EXECUTABLE_ENV]: pinnedBinaryFirst.executablePath,
};
assert.equal(
  hostEnv[HAPPYPAW_CODEX_EXECUTABLE_ENV],
  pinnedBinaryFirst.executablePath,
);
const pinnedBinarySecond = ensurePinnedCodexHostBinary({
  cacheRoot: hostCacheRoot,
  downloadArchive: () => {
    throw new Error('cache reuse should skip download');
  },
});
assert.equal(pinnedBinarySecond.downloaded, false);
assert.equal(
  pinnedBinarySecond.executablePath,
  pinnedBinaryFirst.executablePath,
);
assert.equal(
  getPinnedCodexContainerExecutablePath(),
  '/opt/happypaw/bin/codex',
);
assert.equal(
  getPinnedCodexRepoCacheRoot(),
  path.join(repoRoot, '.happypaw', 'cache', 'codex', 'repo'),
);

console.log('✅ codex home bootstrap checks passed');

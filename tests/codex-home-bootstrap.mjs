#!/usr/bin/env node

import assert from 'node:assert/strict';
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

const { getCodexProviderConfig } = runtimeConfigModule;
const {
  INTERNAL_MCP_BRIDGE_ID,
  CURRENT_PRODUCT_ID,
  LEGACY_PRODUCT_ID,
} = await import(path.join(repoRoot, 'dist', 'legacy-product.js'));
const {
  prepareCodexHome,
  readCodexMcpServersFromSettings,
  mergeCodexMcpServers,
} = codexConfigModule;
const {
  initDatabase,
  setSession,
  getRuntimeSession,
  getAllSessions,
} = dbModule;

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
assert.match(prepared.configToml, /HAPPYPAW_WORKSPACE_GLOBAL = "\/workspace\/global"/);
assert.match(prepared.configToml, /HAPPYPAW_WORKSPACE_MEMORY = "\/workspace\/memory"/);
assert.match(prepared.configToml, /HAPPYPAW_WORKSPACE_IPC = "\/workspace\/ipc"/);
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

initDatabase();
setSession('folder-a', 'thread-123', undefined, 'codex_app_server');
setSession('folder-a', 'agent-thread-456', 'agent-1', 'codex_app_server');
setSession('folder-b', 'claude-session-789', undefined, 'claude_sdk');

assert.deepEqual(getRuntimeSession('folder-a'), {
  sessionId: 'thread-123',
  runtime: 'codex_app_server',
});
assert.deepEqual(getRuntimeSession('folder-a', 'agent-1'), {
  sessionId: 'agent-thread-456',
  runtime: 'codex_app_server',
});
assert.deepEqual(getAllSessions(), {
  'folder-a': { sessionId: 'thread-123', runtime: 'codex_app_server' },
  'folder-b': { sessionId: 'claude-session-789', runtime: 'claude_sdk' },
});

console.log('✅ codex home bootstrap checks passed');

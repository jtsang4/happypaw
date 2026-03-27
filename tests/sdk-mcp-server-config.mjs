#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const distRoot = path.join(repoRoot, 'container', 'agent-runner', 'dist');

const [
  { buildSdkMcpServerEntries },
  { createMcpTools },
  { CURRENT_PRODUCT_ID, LEGACY_PRODUCT_ID },
] =
  await Promise.all([
    import(path.join(distRoot, 'sdk-mcp-server-config.js')),
    import(path.join(distRoot, 'mcp-tools.js')),
    import(path.join(distRoot, 'legacy-product.js')),
  ]);

const entries = buildSdkMcpServerEntries([]);

assert.equal(typeof entries[CURRENT_PRODUCT_ID], 'object');
assert.equal(typeof entries[LEGACY_PRODUCT_ID], 'object');
assert.notEqual(
  entries[CURRENT_PRODUCT_ID],
  entries[LEGACY_PRODUCT_ID],
  'Current and legacy MCP aliases must use distinct SDK server instances',
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-mcp-server-config-'));
const workspaceGroup = path.join(tempRoot, 'group');
const workspaceGlobal = path.join(tempRoot, 'global');
const workspaceMemory = path.join(tempRoot, 'memory');
const workspaceIpc = path.join(tempRoot, 'ipc');
for (const dir of [
  workspaceGroup,
  workspaceGlobal,
  workspaceMemory,
  workspaceIpc,
  path.join(workspaceIpc, 'messages'),
  path.join(workspaceIpc, 'tasks'),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const tools = createMcpTools({
  chatJid: 'telegram:test-chat',
  groupFolder: 'demo-folder',
  ownerId: 'owner-1',
  runtime: 'codex_app_server',
  productId: 'happypaw',
  isHome: true,
  isAdminHome: true,
  workspaceIpc,
  workspaceGroup,
  workspaceGlobal,
  workspaceMemory,
});

assert.ok(
  tools.some((tool) => tool.name === 'get_context'),
  'in-process MCP tools expose get_context alongside the bridge tool set',
);

const getContext = tools.find((tool) => tool.name === 'get_context');
const contextResult = await getContext.handler({});
assert.match(
  contextResult.content[0].text,
  /groupFolder=demo-folder[\s\S]*workspace=.*group[\s\S]*ownerId=owner-1[\s\S]*runtime=codex_app_server[\s\S]*productId=happypaw/,
  'get_context returns the active HappyPaw scope context',
);

console.log('sdk MCP server config regression passed');

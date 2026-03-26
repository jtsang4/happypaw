#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const distRoot = path.join(repoRoot, 'container', 'agent-runner', 'dist');

const { buildSdkMcpServerEntries } = await import(
  path.join(distRoot, 'sdk-mcp-server-config.js')
);

const entries = buildSdkMcpServerEntries([]);

assert.equal(typeof entries.happypaw, 'object');
assert.equal(typeof entries.happyclaw, 'object');
assert.notEqual(
  entries.happypaw,
  entries.happyclaw,
  'HappyPaw and legacy MCP aliases must use distinct SDK server instances',
);

console.log('sdk MCP server config regression passed');

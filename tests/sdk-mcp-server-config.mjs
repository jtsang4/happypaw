#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const distRoot = path.join(repoRoot, 'container', 'agent-runner', 'dist');

const [{ buildSdkMcpServerEntries }, { CURRENT_PRODUCT_ID, LEGACY_PRODUCT_ID }] =
  await Promise.all([
    import(path.join(distRoot, 'sdk-mcp-server-config.js')),
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

console.log('sdk MCP server config regression passed');

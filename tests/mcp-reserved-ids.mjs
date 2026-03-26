#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const userRoutePath = path.join(repoRoot, 'src', 'routes', 'mcp-servers.ts');
const workspaceRoutePath = path.join(
  repoRoot,
  'src',
  'routes',
  'workspace-config.ts',
);
const legacyProductPath = path.join(repoRoot, 'src', 'legacy-product.ts');

const [userRouteSource, workspaceRouteSource, legacyProductSource] =
  await Promise.all([
    readFile(userRoutePath, 'utf8'),
    readFile(workspaceRoutePath, 'utf8'),
    readFile(legacyProductPath, 'utf8'),
  ]);

assert.match(
  legacyProductSource,
  /export const INTERNAL_MCP_BRIDGE_ID = CURRENT_PRODUCT_ID;/,
  'legacy product module defines the reserved internal MCP bridge id',
);
assert.match(
  legacyProductSource,
  /export function isReservedMcpServerId\(value: string\)/,
  'legacy product module exposes a shared reserved-id guard',
);
assert.match(
  userRouteSource,
  /!isReservedMcpServerId\(id\)/,
  'user MCP routes reject the reserved HappyPaw bridge ids',
);
assert.match(
  workspaceRouteSource,
  /!isReservedMcpServerId\(id\)/,
  'workspace MCP routes reject the reserved HappyPaw bridge ids',
);

console.log('✅ reserved MCP id route checks passed');

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const schemasPath = path.join(repoRoot, 'src', 'schemas.ts');
  const groupsRoutePath = path.join(repoRoot, 'src', 'routes', 'groups.ts');
  const createDialogPath = path.join(
    repoRoot,
    'web',
    'src',
    'components',
    'chat',
    'CreateContainerDialog.tsx',
  );
  const createFlowOptionsPath = path.join(
    repoRoot,
    'web',
    'src',
    'components',
    'chat',
    'create-flow-options.ts',
  );
  const groupActionsPath = path.join(
    repoRoot,
    'web',
    'src',
    'stores',
    'chat',
    'actions',
    'group-actions.ts',
  );
  const groupDetailPath = path.join(
    repoRoot,
    'web',
    'src',
    'components',
    'groups',
    'GroupDetail.tsx',
  );

  const [
    schemasSource,
    groupsRouteSource,
    createDialogSource,
    createFlowOptionsSource,
    groupActionsSource,
    groupDetailSource,
  ] = await Promise.all([
    readFile(schemasPath, 'utf8'),
    readFile(groupsRoutePath, 'utf8'),
    readFile(createDialogPath, 'utf8'),
    readFile(createFlowOptionsPath, 'utf8'),
    readFile(groupActionsPath, 'utf8'),
    readFile(groupDetailPath, 'utf8'),
  ]);

  assert.match(
    schemasSource,
    /runtime:\s*z\.enum\(\['codex_app_server'\]\)\.nullable\(\)\.optional\(\)/,
    'GroupPatchSchema allows null to clear a runtime override',
  );
  assert.match(
    groupsRouteSource,
    /const hasRuntimeField = Object\.prototype\.hasOwnProperty\.call\(\s*validation\.data,\s*'runtime',\s*\);/,
    'groups route detects whether the runtime field was explicitly provided',
  );
  assert.match(
    groupsRouteSource,
    /runtime:\s*hasRuntimeField\s*\?\s*\(runtime \?\? undefined\)\s*:\s*existing\.runtime/,
    'groups route clears runtime overrides only when runtime is explicitly null',
  );
  assert.match(
    createDialogSource,
    /useState<RuntimeOverrideSelection>\('__default__'\)/,
    'create dialog defaults runtime selection to inherit system default',
  );
  assert.match(
    createDialogSource,
    /<SelectItem value="__default__">继承系统默认<\/SelectItem>/,
    'create dialog exposes an inherit-system-default runtime option',
  );
  assert.match(
    createFlowOptionsSource,
    /if \(runtimeSelection !== '__default__'\) \{\s*options\.runtime = runtimeSelection;\s*\}/s,
    'buildCreateFlowOptions omits runtime when inheriting the system default',
  );
  assert.match(
    groupActionsSource,
    /if \(options\?\.runtime\) body\.runtime = options\.runtime;/,
    'chat store only sends runtime when an explicit override is chosen',
  );
  assert.match(
    groupDetailSource,
    /value === '__default__' \? null : value/,
    'group detail clears runtime overrides by sending null when system default is chosen',
  );

  console.log('✅ runtime override inheritance checks passed');
}

main().catch((error) => {
  console.error('❌ runtime override inheritance checks failed');
  console.error(error);
  process.exit(1);
});

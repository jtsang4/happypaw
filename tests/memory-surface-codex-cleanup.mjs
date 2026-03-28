#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const readmeSource = read('README.md');
assert.doesNotMatch(
  readmeSource,
  /CLAUDE\.md/u,
  'README should not advertise Claude-branded memory files on supported surfaces',
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

#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

const chatViewSource = fs.readFileSync(
  path.join(repoRoot, 'web', 'src', 'components', 'chat', 'ChatView.tsx'),
  'utf8',
);
const profileSectionSource = fs.readFileSync(
  path.join(
    repoRoot,
    'web',
    'src',
    'components',
    'settings',
    'ProfileSection.tsx',
  ),
  'utf8',
);
const globalStylesSource = fs.readFileSync(
  path.join(repoRoot, 'web', 'src', 'styles', 'globals.css'),
  'utf8',
);

for (const channel of ['feishu', 'telegram', 'qq', 'wechat']) {
  assert.match(
    chatViewSource,
    new RegExp(`key:\\s*'${channel}'`, 'u'),
    `ChatView should include ${channel} in the home IM status surface`,
  );
}

assert.match(
  chatViewSource,
  /未配置 IM 渠道，飞书、Telegram、QQ、微信消息无法与主工作区互通/u,
  'Home workspace banner should mention every supported IM channel',
);

assert.doesNotMatch(
  profileSectionSource,
  /Anthropic/u,
  'Profile settings should not expose Anthropic-branded font options',
);
assert.match(
  profileSectionSource,
  /label:\s*'衬线'/u,
  'Profile settings should expose the generic serif font option label',
);

assert.doesNotMatch(
  globalStylesSource,
  /Anthropic font style/u,
  'Global styles should not retain Anthropic-branded font comments',
);
assert.match(
  globalStylesSource,
  /Serif font style/u,
  'Global styles should describe the generic serif font style',
);

console.log('✅ product-surface-followup assertions passed');

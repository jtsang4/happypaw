#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-im-routing-helpers-'),
);

process.chdir(tempRoot);

const { initDatabase, closeDatabase, setRegisteredGroup } = await import(
  path.join(repoRoot, 'dist', 'db.js')
);
const { findChannelForJid } = await import(
  path.join(repoRoot, 'dist', 'features', 'im', 'core', 'routing-helpers.js')
);

initDatabase();

setRegisteredGroup('telegram:workspace-a', {
  name: 'Workspace A Telegram',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  created_by: 'user-1',
});
setRegisteredGroup('web:workspace-a', {
  name: 'Workspace A Web',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  created_by: 'user-1',
});
setRegisteredGroup('telegram:workspace-a-alt', {
  name: 'Workspace A Alt Telegram',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  created_by: 'user-2',
});

const ownerChannel = {
  channelType: 'telegram',
  connect: async () => true,
  disconnect: async () => {},
  sendMessage: async () => {},
  setTyping: async () => {},
  isConnected: () => true,
};

const offlineChannel = {
  ...ownerChannel,
  isConnected: () => false,
};

const connections = new Map([
  ['user-1', { userId: 'user-1', channels: new Map([['telegram', ownerChannel]]) }],
]);

assert.equal(
  findChannelForJid(connections, 'telegram:workspace-a', 'telegram'),
  ownerChannel,
  'should use the direct owner channel when it is connected',
);

const fallbackConnections = new Map([
  ['user-1', { userId: 'user-1', channels: new Map([['telegram', offlineChannel]]) }],
  ['user-2', { userId: 'user-2', channels: new Map([['telegram', ownerChannel]]) }],
]);

assert.equal(
  findChannelForJid(fallbackConnections, 'telegram:workspace-a', 'telegram'),
  ownerChannel,
  'should fall back to a sibling group owner channel when the direct owner is unavailable',
);

assert.equal(
  findChannelForJid(new Map(), 'telegram:workspace-a', 'telegram'),
  undefined,
  'should return undefined when no matching connected channel exists',
);

closeDatabase();

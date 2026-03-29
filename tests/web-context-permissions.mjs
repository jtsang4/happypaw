#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-web-context-permissions-'),
);

process.chdir(tempRoot);

const { initDatabase, closeDatabase, addGroupMember } = await import(
  path.join(repoRoot, 'dist', 'db.js')
);
const {
  canAccessGroup,
  canModifyGroup,
  canManageGroupMembers,
  canDeleteGroup,
} = await import(path.join(repoRoot, 'dist', 'app', 'web', 'context.js'));

initDatabase();

const owner = { id: 'owner-1', role: 'member' };
const member = { id: 'member-1', role: 'member' };
const outsider = { id: 'outsider-1', role: 'member' };

const homeGroup = {
  jid: 'web:home-owner-1',
  name: 'Owner Home',
  folder: 'home-owner-1',
  added_at: new Date().toISOString(),
  created_by: owner.id,
  is_home: true,
};

assert.equal(canAccessGroup(owner, homeGroup), true);
assert.equal(canAccessGroup(member, homeGroup), false);
assert.equal(canModifyGroup(owner, homeGroup), true);
assert.equal(canModifyGroup(member, homeGroup), false);
assert.equal(canManageGroupMembers(owner, homeGroup), false);
assert.equal(canDeleteGroup(owner, homeGroup), false);

const sharedWebGroup = {
  jid: 'web:workspace-a',
  name: 'Workspace A',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  created_by: owner.id,
  is_home: false,
};

addGroupMember(sharedWebGroup.folder, member.id, 'member', owner.id);

assert.equal(canAccessGroup(owner, sharedWebGroup), true);
assert.equal(canAccessGroup(member, sharedWebGroup), true);
assert.equal(canAccessGroup(outsider, sharedWebGroup), false);
assert.equal(canModifyGroup(owner, sharedWebGroup), true);
assert.equal(canModifyGroup(member, sharedWebGroup), false);
assert.equal(canManageGroupMembers(owner, sharedWebGroup), true);
assert.equal(canManageGroupMembers(member, sharedWebGroup), false);
assert.equal(canDeleteGroup(owner, sharedWebGroup), true);
assert.equal(canDeleteGroup(member, sharedWebGroup), false);

const sharedImGroup = {
  ...sharedWebGroup,
  jid: 'telegram:workspace-a',
};

assert.equal(canAccessGroup(member, sharedImGroup), true);
assert.equal(canAccessGroup(outsider, sharedImGroup), false);

const mainGroup = {
  jid: 'web:main',
  name: 'Main',
  folder: 'main',
  added_at: new Date().toISOString(),
  created_by: owner.id,
  is_home: false,
};

addGroupMember(mainGroup.folder, member.id, 'member', owner.id);

assert.equal(canAccessGroup(owner, mainGroup), true);
assert.equal(canAccessGroup(member, mainGroup), true);
assert.equal(canAccessGroup(outsider, mainGroup), false);

closeDatabase();

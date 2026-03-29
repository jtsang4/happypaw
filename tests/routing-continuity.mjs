import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-routing-continuity-'),
);
const realTempRoot = fs.realpathSync(tempRoot);
process.chdir(realTempRoot);

const { initDatabase, closeDatabase, setRegisteredGroup, createAgent, updateAgentLastImJid } =
  await import(path.join(repoRoot, 'dist', 'db.js'));
const { createIpcRuntime } = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'ipc-runtime.js')
);
const {
  getActiveImReplyRouteSnapshotPath,
  persistActiveImReplyRoute,
  resolveReplyRouteJid,
} = await import(
  path.join(repoRoot, 'dist', 'features', 'chat-runtime', 'im-routing.js')
);
const { getScopedImReplyRouteSnapshotPath } = await import(
  path.join(
    repoRoot,
    'dist',
    'features',
    'chat-runtime',
    'im-reply-route-snapshot.js',
  )
);

initDatabase();

setRegisteredGroup('web:home-main', {
  name: 'Home Main',
  folder: 'home-1',
  added_at: new Date().toISOString(),
  created_by: 'user-1',
  is_home: true,
});
setRegisteredGroup('telegram:home-1', {
  name: 'Home Telegram',
  folder: 'home-1',
  added_at: new Date().toISOString(),
  created_by: 'user-1',
});
setRegisteredGroup('web:workspace-a', {
  name: 'Workspace A',
  folder: 'workspace-a',
  added_at: new Date().toISOString(),
  created_by: 'user-1',
});

createAgent({
  id: 'agent-1',
  group_folder: 'workspace-a',
  chat_jid: 'web:workspace-a',
  name: 'Agent One',
  prompt: 'route test',
  status: 'idle',
  kind: 'conversation',
  created_by: 'user-1',
  created_at: new Date().toISOString(),
  completed_at: null,
  result_summary: null,
  last_im_jid: null,
  spawned_from_jid: null,
});

updateAgentLastImJid('agent-1', 'telegram:bound-agent');

const sentMessages = [];
const sentIms = [];
const sentImages = [];
const sentFiles = [];

persistActiveImReplyRoute('home-1', 'telegram:home-1');

assert.equal(
  resolveReplyRouteJid(
    new Map([['workspace-a', 'telegram:main-active']]),
    'workspace-a',
    'web:workspace-a',
    'agent-1',
    () => true,
  ),
  'telegram:bound-agent',
  'agent fallback routing prefers the persisted agent IM binding over folder-wide active IM state',
);

assert.equal(
  resolveReplyRouteJid(
    new Map([['home-1', 'telegram:home-1']]),
    'home-1',
    'web:home-main',
  ),
  'telegram:home-1',
  'main conversation fallback routing still uses the folder-wide active IM state',
);

const runtime = createIpcRuntime({
  dataDir: path.join(realTempRoot, 'data'),
  groupsDir: path.join(realTempRoot, 'data', 'groups'),
  mainGroupFolder: 'main',
  timezone: 'UTC',
  assistantName: 'HappyPaw',
  getRegisteredGroups: () => ({
    'web:home-main': {
      name: 'Home Main',
      folder: 'home-1',
      added_at: '',
      created_by: 'user-1',
      is_home: true,
    },
    'telegram:home-1': {
      name: 'Home Telegram',
      folder: 'home-1',
      added_at: '',
      created_by: 'user-1',
    },
    'web:workspace-a': {
      name: 'Workspace A',
      folder: 'workspace-a',
      added_at: '',
      created_by: 'user-1',
    },
  }),
  getShuttingDown: () => false,
  getActiveImReplyRoute: (folder) =>
    folder === 'home-1' ? 'telegram:home-1' : null,
  getAgentReplyRouteJid: (_folder, chatJid, agentId) => {
    if (agentId === 'agent-1') return 'telegram:bound-agent';
    if (chatJid === 'web:home-main') return 'telegram:home-1';
    return undefined;
  },
  sendMessage: async (jid, text, options) => {
    sentMessages.push({ jid, text, options });
    return `msg-${sentMessages.length}`;
  },
  ensureChatExists: () => {},
  storeMessageDirect: () => 'stored',
  broadcastNewMessage: () => {},
  broadcastToWebClients: () => {},
  extractLocalImImagePaths: () => [],
  sendImWithFailTracking: (jid, text) => {
    sentIms.push({ jid, text });
  },
  retryImOperation: async (_op, jid, fn) => {
    await fn();
    return true;
  },
  getChannelType: (jid) => {
    if (jid.startsWith('telegram:')) return 'telegram';
    if (jid.startsWith('web:')) return null;
    return null;
  },
  getGroupsByOwner: () => [],
  getConnectedChannelTypes: () => [],
  sendImage: async (jid, _buf, _mime, caption, fileName) => {
    sentImages.push({ jid, caption, fileName });
  },
  sendFile: async (jid, filePath, fileName) => {
    sentFiles.push({ jid, filePath, fileName });
  },
  createTask: () => {},
  deleteTask: () => {},
  getAllTasks: () => [],
  getTaskById: () => undefined,
  updateTask: () => {},
  syncGroupMetadata: async () => {},
  getAvailableGroups: () => [],
  writeGroupsSnapshot: () => {},
  registerGroup: () => {},
  installSkillForUser: async () => ({}),
  deleteSkillForUser: () => ({}),
});

runtime.startIpcWatcher();

const homeMessagesDir = path.join(realTempRoot, 'data', 'ipc', 'home-1', 'messages');
fs.mkdirSync(homeMessagesDir, { recursive: true });
fs.writeFileSync(
  path.join(homeMessagesDir, 'home-message.json'),
  JSON.stringify({
    type: 'message',
    chatJid: 'web:home-main',
    text: 'home continuity side channel',
  }),
);

const agentMessagesDir = path.join(
  realTempRoot,
  'data',
  'ipc',
  'workspace-a',
  'agents',
  'agent-1',
  'messages',
);
fs.mkdirSync(agentMessagesDir, { recursive: true });
fs.writeFileSync(
  path.join(agentMessagesDir, 'agent-message.json'),
  JSON.stringify({
    type: 'message',
    chatJid: 'web:workspace-a',
    text: 'agent scope side channel',
  }),
);

fs.mkdirSync(path.join(realTempRoot, 'data', 'groups', 'workspace-a'), {
  recursive: true,
});
fs.writeFileSync(
  path.join(realTempRoot, 'data', 'groups', 'workspace-a', 'report.txt'),
  'hello',
);
fs.writeFileSync(
  path.join(
    realTempRoot,
    'data',
    'ipc',
    'workspace-a',
    'agents',
    'agent-1',
    'file-send.json',
  ),
  '',
);
fs.writeFileSync(
  path.join(agentMessagesDir, 'ignored.json'),
  JSON.stringify({
    type: 'noop',
  }),
);

const agentTasksDir = path.join(
  realTempRoot,
  'data',
  'ipc',
  'workspace-a',
  'agents',
  'agent-1',
  'tasks',
);
fs.mkdirSync(agentTasksDir, { recursive: true });
fs.writeFileSync(
  path.join(agentTasksDir, 'send-file.json'),
  JSON.stringify({
    type: 'send_file',
    chatJid: 'web:workspace-a',
    filePath: 'report.txt',
    fileName: 'report.txt',
  }),
);

const imageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0QkAAAAASUVORK5CYII=',
  'base64',
);
fs.writeFileSync(
  path.join(agentMessagesDir, 'send-image.json'),
  JSON.stringify({
    type: 'image',
    chatJid: 'web:workspace-a',
    imageBase64: imageBuffer.toString('base64'),
    mimeType: 'image/png',
    fileName: 'proof.png',
  }),
);

const scopedSnapshot = getScopedImReplyRouteSnapshotPath(
  path.join(realTempRoot, 'data', 'ipc', 'workspace-a', 'agents', 'agent-1'),
);
assert.equal(
  scopedSnapshot,
  path.join(
    realTempRoot,
    'data',
    'ipc',
    'workspace-a',
    'agents',
    'agent-1',
    'active_im_reply_route.json',
  ),
);
assert.equal(
  getActiveImReplyRouteSnapshotPath('home-1'),
  path.join(realTempRoot, 'data', 'ipc', 'home-1', 'active_im_reply_route.json'),
);

await new Promise((resolve) => setTimeout(resolve, 5600));
runtime.closeAll();

assert.deepEqual(
  sentMessages.map(({ jid, text, options }) => ({
    jid,
    text,
    source: options?.source ?? null,
    sourceKind: options?.messageMeta?.sourceKind ?? null,
  })),
  [
    {
      jid: 'web:home-main',
      text: 'home continuity side channel',
      source: null,
      sourceKind: 'sdk_send_message',
    },
    {
      jid: 'web:workspace-a#agent:agent-1',
      text: 'agent scope side channel',
      source: 'agent_ipc',
      sourceKind: 'sdk_send_message',
    },
  ],
  'home workspace and agent side-channel messages stay in their intended scopes',
);

assert.deepEqual(
  sentIms,
  [
    { jid: 'telegram:home-1', text: 'home continuity side channel' },
    { jid: 'telegram:bound-agent', text: 'agent scope side channel' },
  ],
  'home and agent routes forward IM side-channels to the intended IM bindings',
);

assert.deepEqual(
  sentFiles,
  [
    {
      jid: 'telegram:bound-agent',
      filePath: path.join(
        realTempRoot,
        'data',
        'groups',
        'workspace-a',
        'report.txt',
      ),
      fileName: 'report.txt',
    },
  ],
  'agent-scoped file delivery resolves through the bound IM route',
);

assert.deepEqual(
  sentImages,
  [
    { jid: 'telegram:bound-agent', caption: undefined, fileName: 'proof.png' },
  ],
  'agent-scoped image delivery resolves through the bound IM route',
);

console.log('✅ routing continuity checks passed');
closeDatabase();
process.exit(0);

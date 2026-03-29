import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happypaw-fresh-container-startup-'),
);
const fakeBinDir = path.join(tempRoot, 'fake-bin');
const fakeDockerPath = path.join(fakeBinDir, 'docker');
const fakeDockerArgsPath = path.join(tempRoot, 'fake-docker-args.txt');
const fakeDockerStdinPath = path.join(tempRoot, 'fake-docker-stdin.txt');

fs.mkdirSync(fakeBinDir, { recursive: true });
fs.writeFileSync(
  fakeDockerPath,
  `#!/bin/sh
cat > "$FAKE_DOCKER_STDIN_FILE"
printf '%s\n' "$@" > "$FAKE_DOCKER_ARGS_FILE"
if [ -n "$FAKE_DOCKER_STDERR" ]; then
  printf '%s\n' "$FAKE_DOCKER_STDERR" >&2
fi
exit "\${FAKE_DOCKER_EXIT_CODE:-0}"
`,
  { mode: 0o755 },
);

process.chdir(tempRoot);
process.env.OPENAI_BASE_URL = 'https://codex.example.com/v1';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.OPENAI_MODEL = 'gpt-5.1-codex';
process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`;
process.env.FAKE_DOCKER_ARGS_FILE = fakeDockerArgsPath;
process.env.FAKE_DOCKER_STDIN_FILE = fakeDockerStdinPath;

const { runContainerAgent } = await import(
  path.join(repoRoot, 'dist', 'features', 'execution', 'container-runner.js')
);

function makeGroup(folder) {
  return {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    runtime: 'codex_app_server',
    created_by: 'u1',
    is_home: false,
  };
}

function makeInput(folder) {
  return {
    prompt: '请先发送一条中途进度消息，再继续输出最终答复。',
    groupFolder: folder,
    chatJid: `web:${folder}`,
    isHome: false,
    isAdminHome: false,
  };
}

const successFolder = 'fresh-success';
process.env.FAKE_DOCKER_EXIT_CODE = '0';
delete process.env.FAKE_DOCKER_STDERR;

const successResult = await runContainerAgent(
  makeGroup(successFolder),
  makeInput(successFolder),
  () => {},
  async () => {},
);

assert.equal(successResult.status, 'success');
assert.ok(
  fs.existsSync(path.join(tempRoot, 'data', 'groups', successFolder, 'logs')),
  'fresh workspace gets a logs directory before the container starts',
);
assert.equal(
  fs.existsSync(
    path.join(
      tempRoot,
      'data',
      'groups',
      successFolder,
      '.happypaw',
      'workspace-mcp.json',
    ),
  ),
  false,
  'fresh container startup no longer creates or depends on workspace .happypaw/workspace-mcp.json',
);
assert.ok(
  fs.existsSync(
    path.join(
      tempRoot,
      'data',
      'sessions',
      successFolder,
      '.codex',
      'config.toml',
    ),
  ),
  'fresh container startup still prepares the Codex home',
);
const successEnvFile = path.join(
  tempRoot,
  'data',
  'env',
  successFolder,
  'env',
);
assert.ok(fs.existsSync(successEnvFile), 'fresh startup writes the mounted env file');
const successEnvContent = fs.readFileSync(successEnvFile, 'utf8');
assert.doesNotMatch(
  successEnvContent,
  /^OPENAI_BASE_URL=/mu,
  'fresh container startup should not export deprecated OPENAI_BASE_URL because Codex config.toml owns the base URL',
);

const capturedArgs = fs.readFileSync(fakeDockerArgsPath, 'utf8');
assert.match(capturedArgs, /happypaw-agent:latest/u);
assert.match(capturedArgs, /\/home\/node\/\.codex/u);
const dockerfileContent = fs.readFileSync(
  path.join(repoRoot, 'container', 'Dockerfile'),
  'utf8',
);
assert.match(
  dockerfileContent,
  /\bbubblewrap\b/u,
  'container image should install bubblewrap so supported startup paths do not fall back to avoidable sandbox-warning noise',
);

const failingFolder = 'fresh-failure';
process.env.FAKE_DOCKER_EXIT_CODE = '1';
process.env.FAKE_DOCKER_STDERR = 'synthetic docker failure';

const failureResult = await runContainerAgent(
  makeGroup(failingFolder),
  makeInput(failingFolder),
  () => {},
  async () => {},
);

assert.equal(failureResult.status, 'error');
assert.match(failureResult.error || '', /exited with code 1/u);

const failureLogsDir = path.join(
  tempRoot,
  'data',
  'groups',
  failingFolder,
  'logs',
);
assert.ok(
  fs.existsSync(failureLogsDir),
  'fresh workspace failures still leave the expected logs directory behind',
);
const failureLogFiles = fs
  .readdirSync(failureLogsDir)
  .filter((entry) => entry.endsWith('.log'));
assert.ok(
  failureLogFiles.length > 0,
  'a failed fresh startup writes runtime evidence into the logs directory',
);
assert.equal(
  fs.existsSync(
    path.join(
      tempRoot,
      'data',
      'groups',
      failingFolder,
      '.happypaw',
      'workspace-mcp.json',
    ),
  ),
  false,
  'fresh failure path still avoids creating workspace MCP config by default',
);

console.log('✅ fresh container startup path checks passed');

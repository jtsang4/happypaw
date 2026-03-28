#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = '/Users/jtsang/Documents/workspace/github/jtsang4/happypaw';

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const bugReportSource = read('src/routes/bug-report.ts');
assert.match(
  bugReportSource,
  /requestCodexHelperJson/u,
  'bug report generation should use the Codex helper client',
);
assert.doesNotMatch(
  bugReportSource,
  /claude\s+--print|execFile\(\s*['"]claude['"]/u,
  'bug report generation should not shell out to Claude CLI',
);
assert.doesNotMatch(
  bugReportSource,
  /claudeAvailable/u,
  'bug report capabilities should not expose legacy Claude availability',
);

const workspaceConfigSource = read('src/routes/workspace-config.ts');
assert.match(
  workspaceConfigSource,
  /workspace-config-storage\.js/u,
  'workspace config routes should use the shared workspace storage helpers',
);
assert.match(
  workspaceConfigSource,
  /\.happypaw/u,
  'workspace config routes should describe the HappyPaw workspace storage root',
);
assert.doesNotMatch(
  workspaceConfigSource,
  /\.claude/u,
  'workspace config routes should no longer reference legacy Claude workspace storage',
);

const skillsSource = read('src/routes/skills.ts');
assert.match(
  skillsSource,
  /\.codex\/skills/u,
  'host skill sync should read Codex skill storage',
);
assert.doesNotMatch(
  skillsSource,
  /\.claude\/skills/u,
  'skill routes should not reference legacy Claude skill storage',
);
assert.doesNotMatch(
  skillsSource,
  /npx['"],\s*\['-y',\s*'skills'/u,
  'skill installation/search should not shell out to the legacy skills CLI',
);

const mcpServersSource = read('src/routes/mcp-servers.ts');
assert.match(
  mcpServersSource,
  /\.codex', 'config\.toml'/u,
  'host MCP sync should read Codex host config.toml',
);
assert.doesNotMatch(
  mcpServersSource,
  /\.claude|\.claude\.json/u,
  'host MCP sync should no longer import Claude config files',
);

const agentDefinitionsSource = read('src/routes/agent-definitions.ts');
assert.match(
  agentDefinitionsSource,
  /\.factory', 'droids'/u,
  'agent definition management should use the current non-Claude storage directory',
);
assert.match(
  agentDefinitionsSource,
  /ensureAgentDefinitionFrontmatter/u,
  'agent definition writes should preserve required frontmatter for existing stored definitions',
);
assert.doesNotMatch(
  agentDefinitionsSource,
  /\.claude', 'agents'/u,
  'agent definition management should not use Claude agent storage',
);

const containerRunnerSource = read('src/container-runner.ts');
assert.match(
  containerRunnerSource,
  /workspace-mcp\.json/u,
  'container runner should consume workspace MCP config from the HappyPaw workspace config file',
);
assert.match(
  containerRunnerSource,
  /\.happypaw\/skills/u,
  'container runner host-mode skill linking should target the HappyPaw workspace skill directory',
);
assert.doesNotMatch(
  containerRunnerSource,
  /\.claude\/settings\.json/u,
  'container runner should not look for legacy workspace settings.json',
);

const workspaceSkillsPanel = read('web/src/components/chat/WorkspaceSkillsPanel.tsx');
assert.match(
  workspaceSkillsPanel,
  /\.happypaw\/skills\//u,
  'workspace skills UI should describe the HappyPaw storage directory',
);

const workspaceMcpPanel = read('web/src/components/chat/WorkspaceMcpPanel.tsx');
assert.match(
  workspaceMcpPanel,
  /\.happypaw\/workspace-mcp\.json/u,
  'workspace MCP UI should describe the HappyPaw workspace MCP config file',
);

const agentDefinitionsPage = read('web/src/pages/AgentDefinitionsPage.tsx');
assert.match(
  agentDefinitionsPage,
  /\.factory\/droids\/\*\.md/u,
  'agent definition UI should mention the current implementation storage path',
);
assert.doesNotMatch(
  agentDefinitionsPage,
  /Droid|subagent_type/u,
  'agent definition UI should stay Agent-branded and avoid Task/droid product copy',
);
assert.match(
  agentDefinitionsPage,
  /model: inherit/u,
  'new agent definition templates should include compatible frontmatter',
);

console.log('✅ helper-ops-cutover assertions passed');

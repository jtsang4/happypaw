// Agent definitions management routes.
// HappyPaw stores Codex custom-agent definitions as TOML files, defaulting to
// workspace-local .codex/agents/*.toml. Optional user-global
// ~/.codex/agents/*.toml access is available only when explicitly requested.

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { logger } from '../logger.js';

const agentDefinitionsRoutes = new Hono<{ Variables: Variables }>();
type AgentStorageMode = 'project' | 'global';

const TOML_AGENT_HINT_PATTERN =
  /^\s*(name|description|model|tools|prompt)\s*=/mu;

// --- Types ---

interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  updatedAt: string;
}

interface AgentDefinitionDetail extends AgentDefinition {
  content: string;
}

// --- Utility Functions ---

function resolveStorageMode(raw: unknown): AgentStorageMode {
  return raw === 'global' ? 'global' : 'project';
}

function getAgentDefinitionsDir(storageMode: AgentStorageMode): string {
  return storageMode === 'global'
    ? path.join(os.homedir(), '.codex', 'agents')
    : path.join(process.cwd(), '.codex', 'agents');
}

function validateAgentId(id: string): boolean {
  return /^[\w\-]+$/.test(id);
}

function decodeTomlString(value: string): string {
  return value
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function extractTomlString(content: string, key: string): string | undefined {
  const patterns = [
    new RegExp(`^\\s*${key}\\s*=\\s*"""([\\s\\S]*?)"""`, 'mu'),
    new RegExp(`^\\s*${key}\\s*=\\s*'''([\\s\\S]*?)'''`, 'mu'),
    new RegExp(`^\\s*${key}\\s*=\\s*"((?:\\\\.|[^"])*)"`, 'mu'),
    new RegExp(`^\\s*${key}\\s*=\\s*'((?:\\\\.|[^'])*)'`, 'mu'),
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1] != null) {
      return decodeTomlString(match[1]).trim();
    }
  }

  return undefined;
}

function extractTomlStringArray(content: string, key: string): string[] {
  const match = content.match(
    new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'mu'),
  );
  if (!match?.[1]) {
    return [];
  }

  const values: string[] = [];
  const valuePattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'/gu;
  for (const entry of match[1].matchAll(valuePattern)) {
    const value = entry[1] ?? entry[2];
    if (value != null) {
      values.push(decodeTomlString(value).trim());
    }
  }

  return values.filter(Boolean);
}

function parseTomlAgentDefinition(
  id: string,
  content: string,
  updatedAt: string,
): AgentDefinition {
  return {
    id,
    name: extractTomlString(content, 'name') || id,
    description: extractTomlString(content, 'description') || '',
    tools: extractTomlStringArray(content, 'tools'),
    updatedAt,
  };
}

function discoverAgents(storageMode: AgentStorageMode): AgentDefinition[] {
  const agentsDir = getAgentDefinitionsDir(storageMode);
  if (!fs.existsSync(agentsDir)) return [];

  const agents: AgentDefinition[] = [];

  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;

      const filePath = path.join(agentsDir, entry.name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const stats = fs.statSync(filePath);
        const id = entry.name.replace(/\.toml$/, '');

        agents.push(
          parseTomlAgentDefinition(id, content, stats.mtime.toISOString()),
        );
      } catch (err) {
        logger.warn(
          { filePath, error: err instanceof Error ? err.message : String(err) },
          'Failed to parse agent file',
        );
      }
    }
  } catch {
    // Directory not readable
  }

  return agents;
}

function getAgentDetail(
  id: string,
  storageMode: AgentStorageMode,
): AgentDefinitionDetail | null {
  if (!validateAgentId(id)) return null;

  const filePath = path.join(getAgentDefinitionsDir(storageMode), `${id}.toml`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const stats = fs.statSync(filePath);
    const parsed = parseTomlAgentDefinition(
      id,
      content,
      stats.mtime.toISOString(),
    );

    return {
      ...parsed,
      content,
    };
  } catch {
    return null;
  }
}

function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function escapeTomlMultilineString(value: string): string {
  return value.replace(/"""/g, '\\"\\"\\"');
}

function ensureTomlAgentContent(content: string, id: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (TOML_AGENT_HINT_PATTERN.test(normalized)) {
    return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  }

  const prompt = normalized || `# ${id}`;
  return [
    `name = "${escapeTomlBasicString(id)}"`,
    'description = ""',
    'model = "inherit"',
    'tools = []',
    '',
    'prompt = """',
    escapeTomlMultilineString(prompt),
    '"""',
    '',
  ].join('\n');
}

// --- Routes ---

// List all agent definitions
agentDefinitionsRoutes.get('/', authMiddleware, (c) => {
  const storageMode = resolveStorageMode(c.req.query('storageMode'));
  const agents = discoverAgents(storageMode);
  return c.json({
    agents,
    storageMode,
    storagePath: getAgentDefinitionsDir(storageMode),
  });
});

// Get single agent detail
agentDefinitionsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const storageMode = resolveStorageMode(c.req.query('storageMode'));
  const agent = getAgentDetail(id, storageMode);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({
    agent,
    storageMode,
    storagePath: getAgentDefinitionsDir(storageMode),
  });
});

// Update agent content
agentDefinitionsRoutes.put(
  '/:id',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const id = c.req.param('id');
    if (!validateAgentId(id)) {
      return c.json({ error: 'Invalid agent ID' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { content } = body as { content: string };
    const storageMode = resolveStorageMode(
      c.req.query('storageMode') ??
        (body as { storageMode?: unknown }).storageMode,
    );
    if (typeof content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }

    const filePath = path.join(
      getAgentDefinitionsDir(storageMode),
      `${id}.toml`,
    );
    try {
      fs.accessSync(filePath);
      fs.writeFileSync(filePath, ensureTomlAgentContent(content, id), 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'Agent definition not found' }, 404);
      }
      throw err;
    }
    return c.json({
      success: true,
      storageMode,
      storagePath: getAgentDefinitionsDir(storageMode),
    });
  },
);

// Create new agent
agentDefinitionsRoutes.post(
  '/',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { name, content } = body as { name: string; content: string };
    const storageMode = resolveStorageMode(
      c.req.query('storageMode') ??
        (body as { storageMode?: unknown }).storageMode,
    );

    if (!name || typeof name !== 'string') {
      return c.json({ error: 'name is required' }, 400);
    }
    if (typeof content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }

    // Derive id from name
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!id || !validateAgentId(id)) {
      return c.json({ error: 'Invalid agent name' }, 400);
    }

    const agentsDir = getAgentDefinitionsDir(storageMode);
    fs.mkdirSync(agentsDir, { recursive: true });

    const filePath = path.join(agentsDir, `${id}.toml`);
    try {
      fs.writeFileSync(filePath, ensureTomlAgentContent(content, id), {
        encoding: 'utf-8',
        flag: 'wx',
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return c.json({ error: 'Agent with this name already exists' }, 409);
      }
      throw err;
    }
    return c.json({
      success: true,
      id,
      storageMode,
      storagePath: agentsDir,
    });
  },
);

// Delete agent
agentDefinitionsRoutes.delete(
  '/:id',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const id = c.req.param('id');
    const storageMode = resolveStorageMode(c.req.query('storageMode'));
    if (!validateAgentId(id)) {
      return c.json({ error: 'Invalid agent ID' }, 400);
    }

    const filePath = path.join(
      getAgentDefinitionsDir(storageMode),
      `${id}.toml`,
    );
    try {
      fs.unlinkSync(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'Agent definition not found' }, 404);
      }
      throw err;
    }
    return c.json({
      success: true,
      storageMode,
      storagePath: getAgentDefinitionsDir(storageMode),
    });
  },
);

export default agentDefinitionsRoutes;

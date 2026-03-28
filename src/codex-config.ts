import fs from 'fs';
import path from 'path';

import {
  INTERNAL_MCP_BRIDGE_ID,
  isReservedMcpServerId,
} from './legacy-product.js';
import type { CodexProviderConfig } from './runtime-config.js';

export interface CodexMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  env_vars?: string[];
  bearer_token_env_var?: string;
  enabled?: boolean;
  required?: boolean;
  startup_timeout_ms?: number;
  tool_timeout_sec?: number;
}

export interface CodexBridgeConfig {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  required?: boolean;
  startup_timeout_ms?: number;
  tool_timeout_sec?: number;
}

export interface PrepareCodexHomeOptions {
  codexHome: string;
  providerConfig: CodexProviderConfig;
  writableRoots: string[];
  workspaceSettingsPath?: string;
  userSettingsPath?: string;
  bridge: CodexBridgeConfig;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ENV_KEY_PROVIDER_ID = 'happypaw_openai';
const ENV_KEY_PROVIDER_NAME = 'HappyPaw OpenAI Compatible';

function tomlEscape(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlEscape(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlEscape(value)).join(', ')}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  return `{ ${entries
    .map(([key, value]) => `${tomlKey(key)} = ${tomlEscape(value)}`)
    .join(', ')} }`;
}

function readJsonObject(
  filePath: string | undefined,
): Record<string, unknown> | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
      string,
      unknown
    > | null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function stripTomlComment(line: string): string {
  let inString = false;
  let escaped = false;
  let result = '';
  for (const char of line) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    if (char === '#' && !inString) {
      break;
    }
    result += char;
  }
  return result.trim();
}

function parseTomlString(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseTomlStringArray(value: string): string[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parseTomlInlineStringTable(
  value: string,
): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return {};

  const result: Record<string, string> = {};
  const entryPattern =
    /([A-Za-z0-9_-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:,|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(inner)) !== null) {
    const rawKey = match[1];
    const key = rawKey.startsWith('"')
      ? parseTomlString(rawKey)
      : rawKey;
    const parsedValue = parseTomlString(match[2]);
    if (!key || parsedValue === undefined) continue;
    result[key] = parsedValue;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function readCodexMcpServersFromTomlConfig(
  configPath: string | undefined,
): Record<string, CodexMcpServerConfig> {
  if (!configPath || !fs.existsSync(configPath)) return {};

  const source = fs.readFileSync(configPath, 'utf8');
  const lines = source.split(/\r?\n/u);
  const result: Record<string, CodexMcpServerConfig> = {};
  let currentId: string | null = null;

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine);
    if (!line) continue;

    const sectionMatch = line.match(
      /^\[mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|([A-Za-z0-9_-]+))\]$/u,
    );
    if (sectionMatch) {
      const parsedQuotedId = sectionMatch[1]
        ? parseTomlString(`"${sectionMatch[1]}"`)
        : undefined;
      const id = parsedQuotedId || sectionMatch[2] || null;
      currentId = id && !isReservedMcpServerId(id) ? id : null;
      if (currentId) result[currentId] = {};
      continue;
    }

    if (/^\[.*\]$/u.test(line)) {
      currentId = null;
      continue;
    }
    if (!currentId) continue;

    const entryMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/u);
    if (!entryMatch) continue;

    const [, key, value] = entryMatch;
    const target = result[currentId];
    switch (key) {
      case 'command': {
        const parsed = parseTomlString(value);
        if (parsed) target.command = parsed;
        break;
      }
      case 'args': {
        const parsed = parseTomlStringArray(value);
        if (parsed) target.args = parsed;
        break;
      }
      case 'env': {
        const parsed = parseTomlInlineStringTable(value);
        if (parsed) target.env = parsed;
        break;
      }
      case 'cwd': {
        const parsed = parseTomlString(value);
        if (parsed) target.cwd = parsed;
        break;
      }
      case 'url': {
        const parsed = parseTomlString(value);
        if (parsed) target.url = parsed;
        break;
      }
      case 'http_headers': {
        const parsed = parseTomlInlineStringTable(value);
        if (parsed) target.http_headers = parsed;
        break;
      }
      case 'enabled':
        if (value === 'true' || value === 'false') {
          target.enabled = value === 'true';
        }
        break;
      default:
        break;
    }
  }

  return Object.fromEntries(
    Object.entries(result).filter(([, server]) => {
      if (server.enabled === false) return false;
      return Boolean(server.command || server.url);
    }),
  );
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => typeof entryValue === 'string')
    .map(([key, entryValue]) => [key, entryValue as string] as const);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  return values.length > 0 ? values : undefined;
}

export function readCodexMcpServersFromSettings(
  settingsPath: string | undefined,
): Record<string, CodexMcpServerConfig> {
  const settings = readJsonObject(settingsPath);
  const rawServers =
    (settings?.mcpServers as
      | Record<string, Record<string, unknown>>
      | undefined) ??
    (settings?.servers as Record<string, Record<string, unknown>> | undefined);
  if (!rawServers || typeof rawServers !== 'object') {
    return {};
  }

  const result: Record<string, CodexMcpServerConfig> = {};
  for (const [id, rawServer] of Object.entries(
    rawServers as Record<string, Record<string, unknown>>,
  )) {
    if (
      isReservedMcpServerId(id) ||
      !rawServer ||
      typeof rawServer !== 'object'
    ) {
      continue;
    }

    const server = rawServer as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(server, 'enabled') &&
      server.enabled === false
    ) {
      continue;
    }
    const url =
      typeof server.url === 'string' && server.url.trim()
        ? server.url.trim()
        : undefined;
    const command =
      typeof server.command === 'string' && server.command.trim()
        ? server.command.trim()
        : undefined;

    if (!url && !command) continue;

    const normalized: CodexMcpServerConfig = {};
    if (url) {
      normalized.url = url;
      normalized.http_headers =
        normalizeStringRecord(server.http_headers) ||
        normalizeStringRecord(server.headers);
      normalized.env_http_headers = normalizeStringRecord(
        server.env_http_headers,
      );
      if (
        typeof server.bearer_token_env_var === 'string' &&
        server.bearer_token_env_var.trim()
      ) {
        normalized.bearer_token_env_var = server.bearer_token_env_var.trim();
      }
    } else if (command) {
      normalized.command = command;
      normalized.args = normalizeStringArray(server.args);
      normalized.env = normalizeStringRecord(server.env);
      normalized.env_vars = normalizeStringArray(server.env_vars);
      if (typeof server.cwd === 'string' && server.cwd.trim()) {
        normalized.cwd = server.cwd.trim();
      }
    }

    if (typeof server.enabled === 'boolean')
      normalized.enabled = server.enabled;
    if (typeof server.required === 'boolean')
      normalized.required = server.required;
    if (
      typeof server.startup_timeout_ms === 'number' &&
      Number.isFinite(server.startup_timeout_ms)
    ) {
      normalized.startup_timeout_ms = server.startup_timeout_ms;
    }
    if (
      typeof server.tool_timeout_sec === 'number' &&
      Number.isFinite(server.tool_timeout_sec)
    ) {
      normalized.tool_timeout_sec = server.tool_timeout_sec;
    }

    result[id] = normalized;
  }

  return result;
}

export function mergeCodexMcpServers(
  userServers: Record<string, CodexMcpServerConfig>,
  workspaceServers: Record<string, CodexMcpServerConfig>,
  bridge: CodexBridgeConfig,
): Record<string, CodexMcpServerConfig> {
  const merged: Record<string, CodexMcpServerConfig> = {
    ...userServers,
    ...workspaceServers,
  };

  for (const id of Object.keys(merged)) {
    if (isReservedMcpServerId(id)) {
      delete merged[id];
    }
  }

  merged[INTERNAL_MCP_BRIDGE_ID] = {
    command: bridge.command,
    args: bridge.args,
    cwd: bridge.cwd,
    env: bridge.env,
    enabled: true,
    required: bridge.required ?? true,
    startup_timeout_ms: bridge.startup_timeout_ms ?? 10_000,
    tool_timeout_sec: bridge.tool_timeout_sec ?? 120,
  };

  return merged;
}

export function buildCodexConfigToml(options: {
  providerConfig: CodexProviderConfig;
  writableRoots: string[];
  mcpServers: Record<string, CodexMcpServerConfig>;
}): string {
  const { providerConfig, mcpServers } = options;
  const writableRoots = Array.from(
    new Set(options.writableRoots.filter((value) => value.trim())),
  );
  const hasEnvApiKey = !!providerConfig.openaiApiKey.trim();
  const effectiveBaseUrl =
    providerConfig.openaiBaseUrl.trim() || DEFAULT_OPENAI_BASE_URL;

  const lines: string[] = [];

  if (providerConfig.openaiModel.trim()) {
    lines.push(`model = ${tomlEscape(providerConfig.openaiModel.trim())}`);
  }
  lines.push(
    `model_provider = ${tomlEscape(hasEnvApiKey ? ENV_KEY_PROVIDER_ID : 'openai')}`,
  );
  if (!hasEnvApiKey && providerConfig.openaiBaseUrl.trim()) {
    lines.push(
      `openai_base_url = ${tomlEscape(providerConfig.openaiBaseUrl.trim())}`,
    );
  }
  lines.push('approval_policy = "never"');
  lines.push('sandbox_mode = "workspace-write"');
  lines.push('');
  lines.push('[sandbox_workspace_write]');
  lines.push(`writable_roots = ${tomlStringArray(writableRoots)}`);
  lines.push('network_access = false');
  lines.push('exclude_tmpdir_env_var = false');
  lines.push('exclude_slash_tmp = false');

  if (hasEnvApiKey) {
    lines.push('');
    lines.push(`[model_providers.${tomlKey(ENV_KEY_PROVIDER_ID)}]`);
    lines.push(`name = ${tomlEscape(ENV_KEY_PROVIDER_NAME)}`);
    lines.push(`base_url = ${tomlEscape(effectiveBaseUrl)}`);
    lines.push('wire_api = "responses"');
    lines.push('env_key = "OPENAI_API_KEY"');
  }

  for (const [id, server] of Object.entries(mcpServers).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push('');
    lines.push(`[mcp_servers.${tomlEscape(id)}]`);

    if (server.command) {
      lines.push(`command = ${tomlEscape(server.command)}`);
    }
    if (server.args && server.args.length > 0) {
      lines.push(`args = ${tomlStringArray(server.args)}`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`env = ${tomlInlineTable(server.env)}`);
    }
    if (server.env_vars && server.env_vars.length > 0) {
      lines.push(`env_vars = ${tomlStringArray(server.env_vars)}`);
    }
    if (server.cwd) {
      lines.push(`cwd = ${tomlEscape(server.cwd)}`);
    }
    if (server.url) {
      lines.push(`url = ${tomlEscape(server.url)}`);
    }
    if (server.http_headers && Object.keys(server.http_headers).length > 0) {
      lines.push(`http_headers = ${tomlInlineTable(server.http_headers)}`);
    }
    if (
      server.env_http_headers &&
      Object.keys(server.env_http_headers).length > 0
    ) {
      lines.push(
        `env_http_headers = ${tomlInlineTable(server.env_http_headers)}`,
      );
    }
    if (server.bearer_token_env_var) {
      lines.push(
        `bearer_token_env_var = ${tomlEscape(server.bearer_token_env_var)}`,
      );
    }
    if (typeof server.enabled === 'boolean') {
      lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`);
    }
    if (typeof server.required === 'boolean') {
      lines.push(`required = ${server.required ? 'true' : 'false'}`);
    }
    if (typeof server.startup_timeout_ms === 'number') {
      lines.push(`startup_timeout_ms = ${server.startup_timeout_ms}`);
    }
    if (typeof server.tool_timeout_sec === 'number') {
      lines.push(`tool_timeout_sec = ${server.tool_timeout_sec}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function prepareCodexHome(options: PrepareCodexHomeOptions): {
  codexHome: string;
  configPath: string;
  configToml: string;
} {
  fs.mkdirSync(options.codexHome, { recursive: true });
  fs.mkdirSync(path.join(options.codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(options.codexHome, 'logs'), { recursive: true });

  const userServers = readCodexMcpServersFromSettings(options.userSettingsPath);
  const workspaceServers = readCodexMcpServersFromSettings(
    options.workspaceSettingsPath,
  );
  const mcpServers = mergeCodexMcpServers(
    userServers,
    workspaceServers,
    options.bridge,
  );
  const configToml = buildCodexConfigToml({
    providerConfig: options.providerConfig,
    writableRoots: options.writableRoots,
    mcpServers,
  });

  const configPath = path.join(options.codexHome, 'config.toml');
  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf8')
    : null;
  if (existing !== configToml) {
    fs.writeFileSync(configPath, configToml, 'utf8');
  }

  return { codexHome: options.codexHome, configPath, configToml };
}

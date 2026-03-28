import crypto from 'crypto';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { HAPPYPAW_CODEX_EXECUTABLE_ENV } from '../codex-binary.js';
import {
  LEGACY_PRODUCT_NAME,
  toLegacyProductEnvToken,
} from '../legacy-product.js';
import type { RuntimeType } from '../types.js';

const MAX_FIELD_LENGTH = 2000;
export const CURRENT_CONFIG_VERSION = 3;
export const DEFAULT_THIRD_PARTY_PROFILE_ID = 'default';
export const DEFAULT_THIRD_PARTY_PROFILE_NAME = '默认第三方';
export const OFFICIAL_CLAUDE_PROFILE_ID = '__official__';

export const CLAUDE_CONFIG_DIR = path.join(DATA_DIR, 'config');
export const CLAUDE_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.json',
);
export const CLAUDE_CONFIG_KEY_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.key',
);
export const CLAUDE_CONFIG_AUDIT_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.audit.log',
);
export const CLAUDE_CUSTOM_ENV_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-custom-env.json',
);
export const FEISHU_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'feishu-provider.json',
);
export const TELEGRAM_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'telegram-provider.json',
);
export const CODEX_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'codex-provider.json',
);
export const REGISTRATION_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'registration.json',
);
export const APPEARANCE_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'appearance.json',
);
export const SYSTEM_SETTINGS_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'system-settings.json',
);
export const USER_IM_CONFIG_DIR = path.join(DATA_DIR, 'config', 'user-im');
export const CONTAINER_ENV_DIR = path.join(DATA_DIR, 'config', 'container-env');

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_CLAUDE_ENV_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);
export const RESERVED_INFRASTRUCTURE_ENV_VARS = new Set([
  'HAPPYPAW_WORKSPACE_GROUP',
  'HAPPYPAW_WORKSPACE_GLOBAL',
  'HAPPYPAW_WORKSPACE_IPC',
  'HAPPYPAW_WORKSPACE_MEMORY',
  HAPPYPAW_CODEX_EXECUTABLE_ENV,
  toLegacyProductEnvToken('HAPPYPAW_WORKSPACE_GROUP'),
  toLegacyProductEnvToken('HAPPYPAW_WORKSPACE_GLOBAL'),
  toLegacyProductEnvToken('HAPPYPAW_WORKSPACE_IPC'),
  toLegacyProductEnvToken(HAPPYPAW_CODEX_EXECUTABLE_ENV),
  'CLAUDE_CONFIG_DIR',
]);
export const DANGEROUS_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'PERL5OPT',
  'PATH',
  'PYTHONPATH',
  'RUBYLIB',
  'PERL5LIB',
  'GIT_EXEC_PATH',
  'CDPATH',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  ...RESERVED_INFRASTRUCTURE_ENV_VARS,
]);
export const MAX_CUSTOM_ENV_ENTRIES = 50;
export const MAX_THIRD_PARTY_PROFILES = 20;

export function normalizeSecret(input: unknown, fieldName: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Invalid field: ${fieldName}`);
  }
  // eslint-disable-next-line no-control-regex
  const value = input.replace(/\s+/g, '').replace(/[^\x00-\x7F]/g, '');
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error(`Field too long: ${fieldName}`);
  }
  return value;
}

export function normalizeBaseUrl(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: anthropicBaseUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  return value;
}

export function normalizeModel(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: anthropicModel');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > 128) {
    throw new Error('Field too long: anthropicModel');
  }
  return value;
}

export function normalizeOpenAIBaseUrl(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: openaiBaseUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: openaiBaseUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: openaiBaseUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid field: openaiBaseUrl');
  }
  return value;
}

export function normalizeOpenAIModel(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: openaiModel');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > 128) {
    throw new Error('Field too long: openaiModel');
  }
  return value;
}

export function normalizeRuntimeType(input: unknown): RuntimeType {
  if (input === 'codex_app_server') return input;
  throw new Error('Invalid runtime type');
}

export function normalizeFeishuAppId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: appId');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: appId');
  }
  return value;
}

export function normalizeTelegramProxyUrl(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    throw new Error('Invalid field: proxyUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: proxyUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: proxyUrl');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(protocol)) {
    throw new Error('Invalid field: proxyUrl');
  }
  return value;
}

export function normalizeProfileName(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: name');
  }
  const value = input.trim();
  if (!value) {
    throw new Error('Invalid field: name');
  }
  if (value.length > 64) {
    throw new Error('Field too long: name');
  }
  return value;
}

export function normalizeProfileId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: id');
  }
  const value = input.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new Error('Invalid field: id');
  }
  return value;
}

export function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

export function sanitizeCustomEnvMap(
  input: Record<string, string>,
  options?: {
    skipReservedLegacyKeys?: boolean;
    skipReservedInfrastructureKeys?: boolean;
  },
): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > MAX_CUSTOM_ENV_ENTRIES) {
    throw new Error(
      `customEnv must have at most ${MAX_CUSTOM_ENV_ENTRIES} entries`,
    );
  }

  const out: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid env key: ${key}`);
    }
    if (options?.skipReservedLegacyKeys && RESERVED_CLAUDE_ENV_KEYS.has(key)) {
      continue;
    }
    if (
      options?.skipReservedInfrastructureKeys &&
      RESERVED_INFRASTRUCTURE_ENV_VARS.has(key)
    ) {
      continue;
    }
    out[key] = sanitizeEnvValue(
      typeof rawValue === 'string' ? rawValue : String(rawValue),
    );
  }
  return out;
}

export function maskSecret(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8) {
    return `${'*'.repeat(Math.max(value.length - 2, 1))}${value.slice(-2)}`;
  }
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 7, 4))}${value.slice(-4)}`;
}

export function maskBaseUrl(value: string): string | null {
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname;
    const maskedHost =
      hostname.length <= 4
        ? '*'.repeat(Math.max(hostname.length, 2))
        : `${hostname.slice(0, 2)}***${hostname.slice(-2)}`;
    const port = parsed.port ? `:${parsed.port}` : '';
    const hasPath = parsed.pathname && parsed.pathname !== '/';
    return `${parsed.protocol}//${maskedHost}${port}${hasPath ? '/***' : ''}`;
  } catch {
    if (value.length <= 8) {
      return `${'*'.repeat(Math.max(value.length - 2, 1))}${value.slice(-2)}`;
    }
    return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 7, 4))}${value.slice(-4)}`;
  }
}

export function parseIntEnv(
  envVar: string | undefined,
  fallback: number,
): number {
  if (!envVar) return fallback;
  const parsed = parseInt(envVar, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseFloatEnv(
  envVar: string | undefined,
  fallback: number,
): number {
  if (!envVar) return fallback;
  const parsed = parseFloat(envVar);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function randomProfileId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export const DEFAULT_APPEARANCE_CONFIG = {
  appName: ASSISTANT_NAME,
  aiName: ASSISTANT_NAME,
  aiAvatarEmoji: '\u{1F431}',
  aiAvatarColor: '#0d9488',
};

export { LEGACY_PRODUCT_NAME };

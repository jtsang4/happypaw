import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../app/config.js';
import { HAPPYPAW_CODEX_EXECUTABLE_ENV } from '../features/execution/codex-binary.js';
import type { RuntimeType } from '../shared/types.js';

const MAX_FIELD_LENGTH = 2000;
export const CONFIG_DIR = path.join(DATA_DIR, 'config');
export const FEISHU_CONFIG_FILE = path.join(CONFIG_DIR, 'feishu-provider.json');
export const TELEGRAM_CONFIG_FILE = path.join(
  CONFIG_DIR,
  'telegram-provider.json',
);
export const CODEX_CONFIG_FILE = path.join(CONFIG_DIR, 'codex-provider.json');
export const REGISTRATION_CONFIG_FILE = path.join(
  CONFIG_DIR,
  'registration.json',
);
export const APPEARANCE_CONFIG_FILE = path.join(CONFIG_DIR, 'appearance.json');
export const SYSTEM_SETTINGS_FILE = path.join(
  CONFIG_DIR,
  'system-settings.json',
);
export const CONFIG_KEYRING_FILE = path.join(
  CONFIG_DIR,
  'runtime-config.keys.json',
);
export const USER_IM_CONFIG_DIR = path.join(DATA_DIR, 'config', 'user-im');
export const CONTAINER_ENV_DIR = path.join(DATA_DIR, 'config', 'container-env');

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_INFRASTRUCTURE_ENV_VARS = new Set([
  'HAPPYPAW_WORKSPACE_GROUP',
  'HAPPYPAW_WORKSPACE_GLOBAL',
  'HAPPYPAW_WORKSPACE_IPC',
  'HAPPYPAW_WORKSPACE_MEMORY',
  HAPPYPAW_CODEX_EXECUTABLE_ENV,
]);
export const DANGEROUS_ENV_VARS = new Set([
  'OPENAI_BASE_URL',
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

export const DEFAULT_APPEARANCE_CONFIG = {
  appName: ASSISTANT_NAME,
  aiName: ASSISTANT_NAME,
  aiAvatarEmoji: '\u{1F431}',
  aiAvatarColor: '#0d9488',
};

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { getCodexProviderConfig } from './im-config.js';
import type {
  ClaudeOAuthCredentials,
  ClaudeProviderConfig,
  CodexProviderConfig,
  ContainerEnvConfig,
  ContainerEnvPublicConfig,
  LocalClaudeCodeStatus,
} from './types.js';
import {
  CONTAINER_ENV_DIR,
  DANGEROUS_ENV_VARS,
  ENV_KEY_RE,
  LEGACY_PRODUCT_NAME,
  sanitizeEnvValue,
} from './shared.js';
import { buildClaudeEnvLines } from './claude-provider.js';

function containerEnvPath(folder: string): string {
  if (folder.includes('..') || folder.includes('/')) {
    throw new Error('Invalid folder name');
  }
  return path.join(CONTAINER_ENV_DIR, `${folder}.json`);
}

function sanitizeContainerCustomEnv(
  input: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!input) return undefined;

  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ENV_KEY_RE.test(key)) {
      logger.warn({ key }, 'Skipping invalid env key in container custom env');
      continue;
    }
    if (DANGEROUS_ENV_VARS.has(key)) {
      logger.warn(
        { key },
        'Blocked reserved env variable in container custom env',
      );
      continue;
    }
    cleanEnv[key] = sanitizeEnvValue(value);
  }
  return cleanEnv;
}

export function getContainerEnvConfig(folder: string): ContainerEnvConfig {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) {
      const stored = JSON.parse(
        fs.readFileSync(filePath, 'utf-8'),
      ) as ContainerEnvConfig & {
        [legacyModelKey: string]: string | undefined;
      };
      const legacyModelKey = `${LEGACY_PRODUCT_NAME.toLowerCase()}Model`;
      if (
        stored.anthropicModel === undefined &&
        stored[legacyModelKey] !== undefined
      ) {
        stored.anthropicModel = stored[legacyModelKey];
        delete stored[legacyModelKey];
      }
      stored.customEnv = sanitizeContainerCustomEnv(stored.customEnv) ?? {};
      return stored;
    }
  } catch (err) {
    logger.warn(
      { err, folder },
      'Failed to read container env config, returning defaults',
    );
  }
  return {};
}

export function saveContainerEnvConfig(
  folder: string,
  config: ContainerEnvConfig,
): void {
  const sanitized: ContainerEnvConfig = { ...config };
  if (sanitized.anthropicBaseUrl)
    sanitized.anthropicBaseUrl = sanitizeEnvValue(sanitized.anthropicBaseUrl);
  if (sanitized.anthropicAuthToken)
    sanitized.anthropicAuthToken = sanitizeEnvValue(
      sanitized.anthropicAuthToken,
    );
  if (sanitized.anthropicApiKey)
    sanitized.anthropicApiKey = sanitizeEnvValue(sanitized.anthropicApiKey);
  if (sanitized.claudeCodeOauthToken)
    sanitized.claudeCodeOauthToken = sanitizeEnvValue(
      sanitized.claudeCodeOauthToken,
    );
  if (sanitized.anthropicModel)
    sanitized.anthropicModel = sanitizeEnvValue(sanitized.anthropicModel);
  sanitized.customEnv = sanitizeContainerCustomEnv(sanitized.customEnv) ?? {};

  fs.mkdirSync(CONTAINER_ENV_DIR, { recursive: true });
  const tmp = `${containerEnvPath(folder)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, containerEnvPath(folder));
}

export function deleteContainerEnvConfig(folder: string): void {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function maskSecret(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8)
    return `${'*'.repeat(Math.max(value.length - 2, 1))}${value.slice(-2)}`;
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 7, 4))}${value.slice(-4)}`;
}

export function toPublicContainerEnvConfig(
  config: ContainerEnvConfig,
): ContainerEnvPublicConfig {
  return {
    anthropicBaseUrl: config.anthropicBaseUrl || '',
    hasAnthropicAuthToken: !!config.anthropicAuthToken,
    hasAnthropicApiKey: !!config.anthropicApiKey,
    hasClaudeCodeOauthToken: !!config.claudeCodeOauthToken,
    anthropicAuthTokenMasked: maskSecret(config.anthropicAuthToken || ''),
    anthropicApiKeyMasked: maskSecret(config.anthropicApiKey || ''),
    claudeCodeOauthTokenMasked: maskSecret(config.claudeCodeOauthToken || ''),
    anthropicModel: config.anthropicModel || '',
    customEnv: sanitizeContainerCustomEnv(config.customEnv) || {},
  };
}

export function mergeClaudeEnvConfig(
  global: ClaudeProviderConfig,
  override: ContainerEnvConfig,
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: override.anthropicBaseUrl || global.anthropicBaseUrl,
    anthropicAuthToken:
      override.anthropicAuthToken || global.anthropicAuthToken,
    anthropicApiKey: override.anthropicApiKey || global.anthropicApiKey,
    claudeCodeOauthToken:
      override.claudeCodeOauthToken || global.claudeCodeOauthToken,
    claudeOAuthCredentials:
      override.claudeOAuthCredentials ?? global.claudeOAuthCredentials,
    anthropicModel: override.anthropicModel || global.anthropicModel,
    updatedAt: global.updatedAt,
  };
}

export function buildContainerEnvLines(
  global: ClaudeProviderConfig,
  override: ContainerEnvConfig,
  profileCustomEnv?: Record<string, string>,
  codexConfig?: CodexProviderConfig,
): string[] {
  const merged = mergeClaudeEnvConfig(global, override);
  const lines = buildClaudeEnvLines(merged, profileCustomEnv);

  const effectiveCodexConfig = codexConfig ?? getCodexProviderConfig();
  if (effectiveCodexConfig.openaiApiKey) {
    lines.push(
      `OPENAI_API_KEY=${sanitizeEnvValue(effectiveCodexConfig.openaiApiKey)}`,
    );
  }
  if (effectiveCodexConfig.openaiBaseUrl) {
    lines.push(
      `OPENAI_BASE_URL=${sanitizeEnvValue(effectiveCodexConfig.openaiBaseUrl)}`,
    );
  }
  if (effectiveCodexConfig.openaiModel) {
    lines.push(
      `OPENAI_MODEL=${sanitizeEnvValue(effectiveCodexConfig.openaiModel)}`,
    );
  }

  const safeCustomEnv = sanitizeContainerCustomEnv(override.customEnv);
  if (safeCustomEnv) {
    for (const [key, value] of Object.entries(safeCustomEnv)) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines;
}

export function writeCredentialsFile(
  sessionDir: string,
  config: ClaudeProviderConfig,
): void {
  const creds = config.claudeOAuthCredentials;
  if (!creds) return;

  const credentialsData = {
    claudeAiOauth: {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      scopes: creds.scopes,
    },
  };

  const filePath = path.join(sessionDir, '.credentials.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(credentialsData, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o644,
  });
  fs.renameSync(tmp, filePath);
}

export function updateAllSessionCredentials(
  config: ClaudeProviderConfig,
): void {
  if (!config.claudeOAuthCredentials) return;

  const sessionsDir = path.join(DATA_DIR, 'sessions');
  try {
    if (!fs.existsSync(sessionsDir)) return;
    for (const folder of fs.readdirSync(sessionsDir)) {
      const claudeDir = path.join(sessionsDir, folder, '.claude');
      if (fs.existsSync(claudeDir) && fs.statSync(claudeDir).isDirectory()) {
        try {
          writeCredentialsFile(claudeDir, config);
        } catch (err) {
          logger.warn(
            { err, folder },
            'Failed to write .credentials.json for session',
          );
        }
      }
      const agentsDir = path.join(sessionsDir, folder, 'agents');
      if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
        for (const agentId of fs.readdirSync(agentsDir)) {
          const agentClaudeDir = path.join(agentsDir, agentId, '.claude');
          if (
            fs.existsSync(agentClaudeDir) &&
            fs.statSync(agentClaudeDir).isDirectory()
          ) {
            try {
              writeCredentialsFile(agentClaudeDir, config);
            } catch (err) {
              logger.warn(
                { err, folder, agentId },
                'Failed to write .credentials.json for agent session',
              );
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to update session credentials');
  }
}

function readLocalOAuthCredentials(): {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  scopes?: string[];
} | null {
  const homeDir = process.env.HOME || '/root';
  const credFile = path.join(homeDir, '.claude', '.credentials.json');

  try {
    if (!fs.existsSync(credFile)) return null;

    const content = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
    const oauth = content?.claudeAiOauth;

    if (oauth?.accessToken && oauth?.refreshToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt:
          typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
        scopes: Array.isArray(oauth.scopes) ? oauth.scopes : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function detectLocalClaudeCode(): LocalClaudeCodeStatus {
  const oauth = readLocalOAuthCredentials();

  if (oauth) {
    return {
      detected: true,
      hasCredentials: true,
      expiresAt: oauth.expiresAt ?? null,
      accessTokenMasked: maskSecret(oauth.accessToken),
    };
  }

  const homeDir = process.env.HOME || '/root';
  const credFile = path.join(homeDir, '.claude', '.credentials.json');
  const fileExists = fs.existsSync(credFile);

  return {
    detected: fileExists,
    hasCredentials: false,
    expiresAt: null,
    accessTokenMasked: null,
  };
}

export function importLocalClaudeCredentials(): ClaudeOAuthCredentials | null {
  const oauth = readLocalOAuthCredentials();
  if (!oauth) return null;

  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt ?? Date.now() + 8 * 3600_000,
    scopes: oauth.scopes ?? [],
  };
}

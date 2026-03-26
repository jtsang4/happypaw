import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import {
  encryptCodexSecret,
  encryptFeishuSecret,
  encryptQQSecret,
  encryptTelegramSecret,
  encryptWeChatSecret,
  decryptCodexSecret,
  decryptQQSecret,
  decryptWeChatSecret,
} from './crypto.js';
import {
  maskBaseUrl,
  maskSecret,
  normalizeFeishuAppId,
  normalizeOpenAIBaseUrl,
  normalizeOpenAIModel,
  normalizeSecret,
  normalizeTelegramProxyUrl,
  CODEX_CONFIG_FILE,
  CLAUDE_CONFIG_DIR,
} from './shared.js';
import {
  readStoredFeishuConfig,
  readStoredTelegramConfig,
  readUserFeishuConfig,
  readUserTelegramConfig,
  userImDir,
} from './provider-im-shared.js';
import type {
  CodexConfigSource,
  CodexProviderConfig,
  CodexProviderPublicConfig,
  EncryptedSecrets,
  FeishuConfigSource,
  FeishuProviderConfig,
  FeishuProviderPublicConfig,
  TelegramConfigSource,
  TelegramProviderConfig,
  TelegramProviderPublicConfig,
  UserFeishuConfig,
  UserQQConfig,
  UserTelegramConfig,
  UserWeChatConfig,
} from './types.js';

interface StoredCodexProviderConfigV1 {
  version: 1;
  openaiBaseUrl: string;
  openaiModel: string;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface StoredQQProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface StoredWeChatProviderConfigV1 {
  version: 1;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  bypassProxy?: boolean;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

function buildCodexConfig(
  input: Omit<CodexProviderConfig, 'updatedAt'>,
  updatedAt: string | null,
): CodexProviderConfig {
  return {
    openaiBaseUrl: normalizeOpenAIBaseUrl(input.openaiBaseUrl),
    openaiApiKey: normalizeSecret(input.openaiApiKey, 'openaiApiKey'),
    openaiModel: normalizeOpenAIModel(input.openaiModel),
    updatedAt,
  };
}

function hasCodexConfigValues(config: CodexProviderConfig | null): boolean {
  return !!(
    config &&
    (config.openaiBaseUrl || config.openaiApiKey || config.openaiModel)
  );
}

function mergeCodexConfigWithFallback(
  runtime: CodexProviderConfig | null,
  fallback: CodexProviderConfig,
): CodexProviderConfig {
  return buildCodexConfig(
    {
      openaiBaseUrl: runtime?.openaiBaseUrl || fallback.openaiBaseUrl,
      openaiApiKey: runtime?.openaiApiKey || fallback.openaiApiKey,
      openaiModel: runtime?.openaiModel || fallback.openaiModel,
    },
    runtime?.updatedAt ?? fallback.updatedAt ?? null,
  );
}

function readStoredCodexConfig(): CodexProviderConfig | null {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) return null;
  const content = fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredCodexProviderConfigV1;
  const secret = decryptCodexSecret(stored.secret);
  return buildCodexConfig(
    {
      openaiBaseUrl: stored.openaiBaseUrl ?? '',
      openaiApiKey: secret.openaiApiKey,
      openaiModel: stored.openaiModel ?? '',
    },
    stored.updatedAt || null,
  );
}

function defaultsCodexFromEnv(): CodexProviderConfig {
  const raw = {
    openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || '',
  };

  try {
    return buildCodexConfig(raw, null);
  } catch {
    return {
      openaiBaseUrl: raw.openaiBaseUrl.trim(),
      openaiApiKey: raw.openaiApiKey.replace(/\s+/g, '').trim(),
      openaiModel: raw.openaiModel.trim(),
      updatedAt: null,
    };
  }
}

function writeStoredCodexConfig(config: CodexProviderConfig): void {
  if (!hasCodexConfigValues(config)) {
    if (fs.existsSync(CODEX_CONFIG_FILE)) {
      fs.unlinkSync(CODEX_CONFIG_FILE);
    }
    return;
  }

  const payload: StoredCodexProviderConfigV1 = {
    version: 1,
    openaiBaseUrl: config.openaiBaseUrl,
    openaiModel: config.openaiModel,
    updatedAt: config.updatedAt || new Date().toISOString(),
    secret: encryptCodexSecret({ openaiApiKey: config.openaiApiKey }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${CODEX_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, CODEX_CONFIG_FILE);
}

export function getFeishuProviderConfigWithSource(): {
  config: FeishuProviderConfig;
  source: FeishuConfigSource;
} {
  try {
    const stored = readStoredFeishuConfig(normalizeFeishuAppId);
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Feishu config, falling back to env',
    );
  }

  const fromEnv = {
    appId: (process.env.FEISHU_APP_ID || '').trim(),
    appSecret: (process.env.FEISHU_APP_SECRET || '').trim(),
    updatedAt: null,
  } satisfies FeishuProviderConfig;
  if (fromEnv.appId || fromEnv.appSecret) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getFeishuProviderConfig(): FeishuProviderConfig {
  return getFeishuProviderConfigWithSource().config;
}

export function saveFeishuProviderConfig(
  next: Omit<FeishuProviderConfig, 'updatedAt'>,
): FeishuProviderConfig {
  const normalized: FeishuProviderConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptFeishuSecret({ appSecret: normalized.appSecret }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const filePath = path.join(CLAUDE_CONFIG_DIR, 'feishu-provider.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function toPublicFeishuProviderConfig(
  config: FeishuProviderConfig,
  source: FeishuConfigSource,
): FeishuProviderPublicConfig {
  return {
    appId: config.appId,
    hasAppSecret: !!config.appSecret,
    appSecretMasked: maskSecret(config.appSecret),
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

export function getTelegramProviderConfigWithSource(): {
  config: TelegramProviderConfig;
  source: TelegramConfigSource;
} {
  try {
    const stored = readStoredTelegramConfig(normalizeTelegramProxyUrl);
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Telegram config, falling back to env',
    );
  }

  const fromEnv: TelegramProviderConfig = {
    botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    proxyUrl: normalizeTelegramProxyUrl(process.env.TELEGRAM_PROXY_URL || ''),
    updatedAt: null,
  };
  if (fromEnv.botToken) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getTelegramProviderConfig(): TelegramProviderConfig {
  return getTelegramProviderConfigWithSource().config;
}

export function saveTelegramProviderConfig(
  next: Omit<TelegramProviderConfig, 'updatedAt'>,
): TelegramProviderConfig {
  const normalized: TelegramProviderConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizeTelegramProxyUrl(next.proxyUrl),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload = {
    version: 1,
    proxyUrl: normalized.proxyUrl,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptTelegramSecret({ botToken: normalized.botToken }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const filePath = path.join(CLAUDE_CONFIG_DIR, 'telegram-provider.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function toPublicTelegramProviderConfig(
  config: TelegramProviderConfig,
  source: TelegramConfigSource,
): TelegramProviderPublicConfig {
  return {
    hasBotToken: !!config.botToken,
    botTokenMasked: maskSecret(config.botToken),
    proxyUrl: config.proxyUrl ?? '',
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

export function getCodexProviderConfigWithSource(): {
  config: CodexProviderConfig;
  source: CodexConfigSource;
} {
  const fromEnv = defaultsCodexFromEnv();

  try {
    const stored = readStoredCodexConfig();
    if (hasCodexConfigValues(stored)) {
      return {
        config: mergeCodexConfigWithFallback(stored, fromEnv),
        source: 'runtime',
      };
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Codex config, falling back to env',
    );
  }

  if (fromEnv.openaiBaseUrl || fromEnv.openaiApiKey || fromEnv.openaiModel) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getCodexProviderConfig(): CodexProviderConfig {
  return getCodexProviderConfigWithSource().config;
}

export function saveCodexProviderConfig(
  next: Partial<Pick<CodexProviderConfig, 'openaiBaseUrl' | 'openaiModel'>>,
): CodexProviderConfig {
  const existingRuntime = readStoredCodexConfig();
  const persisted = buildCodexConfig(
    {
      openaiBaseUrl:
        next.openaiBaseUrl !== undefined
          ? next.openaiBaseUrl.trim()
            ? next.openaiBaseUrl
            : (existingRuntime?.openaiBaseUrl ?? '')
          : (existingRuntime?.openaiBaseUrl ?? ''),
      openaiApiKey: existingRuntime?.openaiApiKey ?? '',
      openaiModel:
        next.openaiModel !== undefined
          ? next.openaiModel.trim()
            ? next.openaiModel
            : (existingRuntime?.openaiModel ?? '')
          : (existingRuntime?.openaiModel ?? ''),
    },
    new Date().toISOString(),
  );
  writeStoredCodexConfig(persisted);
  return mergeCodexConfigWithFallback(persisted, defaultsCodexFromEnv());
}

export function saveCodexProviderSecrets(patch: {
  openaiApiKey?: string;
  clearOpenaiApiKey?: boolean;
}): CodexProviderConfig {
  const existingRuntime = readStoredCodexConfig();
  const persisted = buildCodexConfig(
    {
      openaiBaseUrl: existingRuntime?.openaiBaseUrl ?? '',
      openaiApiKey:
        typeof patch.openaiApiKey === 'string'
          ? patch.openaiApiKey
          : patch.clearOpenaiApiKey
            ? ''
            : (existingRuntime?.openaiApiKey ?? ''),
      openaiModel: existingRuntime?.openaiModel ?? '',
    },
    new Date().toISOString(),
  );
  writeStoredCodexConfig(persisted);
  return mergeCodexConfigWithFallback(persisted, defaultsCodexFromEnv());
}

export function toPublicCodexProviderConfig(
  config: CodexProviderConfig,
  source: CodexConfigSource,
): CodexProviderPublicConfig {
  return {
    hasOpenaiBaseUrl: !!config.openaiBaseUrl,
    openaiBaseUrlMasked: maskBaseUrl(config.openaiBaseUrl),
    openaiModel: config.openaiModel,
    updatedAt: config.updatedAt,
    hasOpenaiApiKey: !!config.openaiApiKey,
    openaiApiKeyMasked: maskSecret(config.openaiApiKey),
    source,
  };
}

export function getUserFeishuConfig(userId: string): UserFeishuConfig | null {
  return readUserFeishuConfig(userId, normalizeFeishuAppId);
}

export function saveUserFeishuConfig(
  userId: string,
  next: Omit<UserFeishuConfig, 'updatedAt'>,
): UserFeishuConfig {
  const normalized: UserFeishuConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptFeishuSecret({ appSecret: normalized.appSecret }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'feishu.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function getUserTelegramConfig(
  userId: string,
): UserTelegramConfig | null {
  return readUserTelegramConfig(userId, normalizeTelegramProxyUrl);
}

export function saveUserTelegramConfig(
  userId: string,
  next: Omit<UserTelegramConfig, 'updatedAt'>,
): UserTelegramConfig {
  const normalizedProxyUrl = next.proxyUrl
    ? normalizeTelegramProxyUrl(next.proxyUrl)
    : '';
  const normalized: UserTelegramConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload = {
    version: 1,
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptTelegramSecret({ botToken: normalized.botToken }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'telegram.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function getUserQQConfig(userId: string): UserQQConfig | null {
  const filePath = path.join(userImDir(userId), 'qq.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredQQProviderConfigV1;
    const secret = decryptQQSecret(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user QQ config');
    return null;
  }
}

export function saveUserQQConfig(
  userId: string,
  next: Omit<UserQQConfig, 'updatedAt'>,
): UserQQConfig {
  const normalized: UserQQConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredQQProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptQQSecret({ appSecret: normalized.appSecret }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'qq.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function getUserWeChatConfig(userId: string): UserWeChatConfig | null {
  const filePath = path.join(userImDir(userId), 'wechat.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredWeChatProviderConfigV1;
    const secret = decryptWeChatSecret(stored.secret);
    return {
      botToken: secret.botToken,
      ilinkBotId: ((stored.ilinkBotId as string) ?? '').trim(),
      baseUrl: stored.baseUrl,
      cdnBaseUrl: stored.cdnBaseUrl,
      getUpdatesBuf: stored.getUpdatesBuf,
      bypassProxy: stored.bypassProxy ?? true,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user WeChat config');
    return null;
  }
}

export function saveUserWeChatConfig(
  userId: string,
  next: Omit<UserWeChatConfig, 'updatedAt'>,
): UserWeChatConfig {
  const normalized: UserWeChatConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    ilinkBotId: (next.ilinkBotId ?? '').trim(),
    baseUrl: next.baseUrl?.trim() || undefined,
    cdnBaseUrl: next.cdnBaseUrl?.trim() || undefined,
    getUpdatesBuf: next.getUpdatesBuf,
    bypassProxy: next.bypassProxy ?? true,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredWeChatProviderConfigV1 = {
    version: 1,
    ilinkBotId: normalized.ilinkBotId,
    baseUrl: normalized.baseUrl,
    cdnBaseUrl: normalized.cdnBaseUrl,
    getUpdatesBuf: normalized.getUpdatesBuf,
    bypassProxy: normalized.bypassProxy,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptWeChatSecret({ botToken: normalized.botToken }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'wechat.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

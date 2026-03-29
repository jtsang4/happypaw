import fs from 'fs';
import path from 'path';

import { logger } from '../app/logger.js';
import {
  FEISHU_CONFIG_FILE,
  TELEGRAM_CONFIG_FILE,
  USER_IM_CONFIG_DIR,
} from './shared.js';
import { decryptFeishuSecret, decryptTelegramSecret } from './crypto.js';
import type {
  EncryptedSecrets,
  FeishuProviderConfig,
  TelegramProviderConfig,
  UserFeishuConfig,
  UserTelegramConfig,
} from './types.js';

interface StoredFeishuProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface StoredTelegramProviderConfigV1 {
  version: 1;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

export function readStoredFeishuConfig(
  normalizeFeishuAppId: (input: unknown) => string,
): FeishuProviderConfig | null {
  if (!fs.existsSync(FEISHU_CONFIG_FILE)) return null;
  const content = fs.readFileSync(FEISHU_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredFeishuProviderConfigV1;
  const secret = decryptFeishuSecret(stored.secret);
  return {
    appId: normalizeFeishuAppId(stored.appId ?? ''),
    appSecret: secret.appSecret,
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

export function readStoredTelegramConfig(
  normalizeTelegramProxyUrl: (input: unknown) => string,
): TelegramProviderConfig | null {
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) return null;
  const content = fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredTelegramProviderConfigV1;
  const secret = decryptTelegramSecret(stored.secret);
  return {
    botToken: secret.botToken,
    proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

export function userImDir(userId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error('Invalid userId');
  }
  return path.join(USER_IM_CONFIG_DIR, userId);
}

export function readUserFeishuConfig(
  userId: string,
  normalizeFeishuAppId: (input: unknown) => string,
): UserFeishuConfig | null {
  const filePath = path.join(userImDir(userId), 'feishu.json');

  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredFeishuProviderConfigV1;
    const secret = decryptFeishuSecret(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Feishu config');
    return null;
  }
}

export function readUserTelegramConfig(
  userId: string,
  normalizeTelegramProxyUrl: (input: unknown) => string,
): UserTelegramConfig | null {
  const filePath = path.join(userImDir(userId), 'telegram.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredTelegramProviderConfigV1;
    const secret = decryptTelegramSecret(stored.secret);
    return {
      botToken: secret.botToken,
      proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Telegram config');
    return null;
  }
}

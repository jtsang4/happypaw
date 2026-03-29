import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { CONFIG_DIR, CONFIG_KEY_FILE, normalizeSecret } from './shared.js';
import type { EncryptedSecrets } from './types.js';

interface FeishuSecretPayload {
  appSecret: string;
}

interface TelegramSecretPayload {
  botToken: string;
}

interface CodexSecretPayload {
  openaiApiKey: string;
}

interface QQSecretPayload {
  appSecret: string;
}

interface WeChatSecretPayload {
  botToken: string;
}

export function getOrCreateEncryptionKey(): Buffer {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const existingKeyPath = resolveExistingKeyPath();
  if (existingKeyPath) {
    const raw = fs.readFileSync(existingKeyPath, 'utf-8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length === 32) return key;
    throw new Error('Invalid encryption key file');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(CONFIG_KEY_FILE, key.toString('hex') + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return key;
}

function resolveExistingKeyPath(): string | null {
  if (fs.existsSync(CONFIG_KEY_FILE)) {
    return CONFIG_KEY_FILE;
  }

  const candidates = fs
    .readdirSync(CONFIG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.key'))
    .map((entry) => path.join(CONFIG_DIR, entry.name));

  if (candidates.length !== 1) {
    return null;
  }

  const [migratedKeySourcePath] = candidates;
  const raw = fs.readFileSync(migratedKeySourcePath, 'utf-8');
  fs.writeFileSync(CONFIG_KEY_FILE, raw, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return CONFIG_KEY_FILE;
}

function encryptPayload(payload: unknown): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptPayload(secrets: EncryptedSecrets): Record<string, unknown> {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return JSON.parse(
    Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      'utf-8',
    ),
  ) as Record<string, unknown>;
}

export function encryptFeishuSecret(
  payload: FeishuSecretPayload,
): EncryptedSecrets {
  return encryptPayload(payload);
}

export function decryptFeishuSecret(
  secrets: EncryptedSecrets,
): FeishuSecretPayload {
  const parsed = decryptPayload(secrets);
  return {
    appSecret: normalizeSecret(parsed.appSecret ?? '', 'appSecret'),
  };
}

export function encryptTelegramSecret(
  payload: TelegramSecretPayload,
): EncryptedSecrets {
  return encryptPayload(payload);
}

export function decryptTelegramSecret(
  secrets: EncryptedSecrets,
): TelegramSecretPayload {
  const parsed = decryptPayload(secrets);
  return {
    botToken: normalizeSecret(parsed.botToken ?? '', 'botToken'),
  };
}

export function encryptCodexSecret(
  payload: CodexSecretPayload,
): EncryptedSecrets {
  return encryptPayload(payload);
}

export function decryptCodexSecret(
  secrets: EncryptedSecrets,
): CodexSecretPayload {
  const parsed = decryptPayload(secrets);
  return {
    openaiApiKey: normalizeSecret(parsed.openaiApiKey ?? '', 'openaiApiKey'),
  };
}

export function encryptQQSecret(payload: QQSecretPayload): EncryptedSecrets {
  return encryptPayload(payload);
}

export function decryptQQSecret(secrets: EncryptedSecrets): QQSecretPayload {
  const parsed = decryptPayload(secrets);
  return {
    appSecret: normalizeSecret(parsed.appSecret ?? '', 'appSecret'),
  };
}

export function encryptWeChatSecret(
  payload: WeChatSecretPayload,
): EncryptedSecrets {
  return encryptPayload(payload);
}

export function decryptWeChatSecret(
  secrets: EncryptedSecrets,
): WeChatSecretPayload {
  const parsed = decryptPayload(secrets);
  return {
    botToken: normalizeSecret(parsed.botToken ?? '', 'botToken'),
  };
}

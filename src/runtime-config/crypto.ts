import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { CONFIG_DIR, CONFIG_KEYRING_FILE, normalizeSecret } from './shared.js';
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

interface RuntimeConfigKeyringV1 {
  version: 1;
  activeKeyId: string;
  keys: Record<string, string>;
}

const KEYRING_VERSION = 1;
const INITIAL_KEY_ID = 'main';

export function getOrCreateEncryptionKey(): Buffer {
  return getActiveEncryptionKey().key;
}

function getActiveEncryptionKey(): { keyId: string; key: Buffer } {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const keyring = getOrCreateKeyring();
  const activeKeyHex = keyring.keys[keyring.activeKeyId];
  if (!activeKeyHex) {
    throw new Error('Invalid runtime config keyring');
  }
  return {
    keyId: keyring.activeKeyId,
    key: decodeKeyHex(activeKeyHex),
  };
}

function getOrCreateKeyring(): RuntimeConfigKeyringV1 {
  const existing = readKeyringFile();
  if (existing) {
    return existing;
  }

  const created = buildKeyring(crypto.randomBytes(32).toString('hex'));
  writeKeyringFile(created);
  return created;
}

function readKeyringFile(): RuntimeConfigKeyringV1 | null {
  if (!fs.existsSync(CONFIG_KEYRING_FILE)) {
    return null;
  }

  const parsed = JSON.parse(
    fs.readFileSync(CONFIG_KEYRING_FILE, 'utf-8'),
  ) as Partial<RuntimeConfigKeyringV1>;
  if (parsed.version !== KEYRING_VERSION) {
    throw new Error('Invalid runtime config keyring');
  }
  if (
    !parsed.activeKeyId ||
    typeof parsed.activeKeyId !== 'string' ||
    !parsed.keys ||
    typeof parsed.keys !== 'object'
  ) {
    throw new Error('Invalid runtime config keyring');
  }
  const activeKeyHex = parsed.keys[parsed.activeKeyId];
  if (typeof activeKeyHex !== 'string') {
    throw new Error('Invalid runtime config keyring');
  }
  decodeKeyHex(activeKeyHex);
  for (const value of Object.values(parsed.keys)) {
    if (typeof value !== 'string') {
      throw new Error('Invalid runtime config keyring');
    }
    decodeKeyHex(value);
  }

  return {
    version: KEYRING_VERSION,
    activeKeyId: parsed.activeKeyId,
    keys: parsed.keys,
  };
}

function buildKeyring(keyHex: string): RuntimeConfigKeyringV1 {
  decodeKeyHex(keyHex);
  return {
    version: KEYRING_VERSION,
    activeKeyId: INITIAL_KEY_ID,
    keys: {
      [INITIAL_KEY_ID]: keyHex,
    },
  };
}

function writeKeyringFile(keyring: RuntimeConfigKeyringV1): void {
  fs.writeFileSync(
    CONFIG_KEYRING_FILE,
    JSON.stringify(keyring, null, 2) + '\n',
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  );
}

function decodeKeyHex(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Invalid encryption key material');
  }
  return key;
}

function encryptPayload(payload: unknown): EncryptedSecrets {
  const { keyId, key } = getActiveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    keyId,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptPayload(secrets: EncryptedSecrets): Record<string, unknown> {
  const key = resolveKeyForSecret(secrets);
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

function resolveKeyForSecret(secrets: EncryptedSecrets): Buffer {
  const keyring = getOrCreateKeyring();
  if (secrets.keyId) {
    const keyHex = keyring.keys[secrets.keyId];
    if (!keyHex) {
      throw new Error('Unknown runtime config key');
    }
    return decodeKeyHex(keyHex);
  }
  const fallbackKeyHex = keyring.keys[keyring.activeKeyId];
  if (!fallbackKeyHex) {
    throw new Error('Invalid runtime config keyring');
  }
  return decodeKeyHex(fallbackKeyHex);
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

import fs from 'fs';

import { logger } from '../logger.js';
import type { SystemSettings } from './types.js';
import {
  CLAUDE_CONFIG_DIR,
  normalizeRuntimeType,
  parseFloatEnv,
  parseIntEnv,
  SYSTEM_SETTINGS_FILE,
} from './shared.js';

const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  defaultRuntime: 'codex_app_server',
  containerTimeout: 1800000,
  idleTimeout: 1800000,
  containerMaxOutputSize: 10485760,
  maxConcurrentContainers: 20,
  maxConcurrentHostProcesses: 5,
  maxLoginAttempts: 5,
  loginLockoutMinutes: 15,
  maxConcurrentScripts: 10,
  scriptTimeout: 60000,
  skillAutoSyncEnabled: false,
  skillAutoSyncIntervalMinutes: 10,
  billingEnabled: false,
  billingMode: 'wallet_first',
  billingMinStartBalanceUsd: 0.01,
  billingCurrency: 'USD',
  billingCurrencyRate: 1,
};

let settingsCache: SystemSettings | null = null;
let settingsMtimeMs = 0;

function readSystemSettingsFromFile(): SystemSettings | null {
  if (!fs.existsSync(SYSTEM_SETTINGS_FILE)) return null;
  const raw = JSON.parse(
    fs.readFileSync(SYSTEM_SETTINGS_FILE, 'utf-8'),
  ) as Record<string, unknown>;
  return {
    defaultRuntime:
      raw.defaultRuntime === 'codex_app_server'
        ? 'codex_app_server'
        : DEFAULT_SYSTEM_SETTINGS.defaultRuntime,
    containerTimeout:
      typeof raw.containerTimeout === 'number' && raw.containerTimeout > 0
        ? raw.containerTimeout
        : DEFAULT_SYSTEM_SETTINGS.containerTimeout,
    idleTimeout:
      typeof raw.idleTimeout === 'number' && raw.idleTimeout > 0
        ? raw.idleTimeout
        : DEFAULT_SYSTEM_SETTINGS.idleTimeout,
    containerMaxOutputSize:
      typeof raw.containerMaxOutputSize === 'number' &&
      raw.containerMaxOutputSize > 0
        ? raw.containerMaxOutputSize
        : DEFAULT_SYSTEM_SETTINGS.containerMaxOutputSize,
    maxConcurrentContainers:
      typeof raw.maxConcurrentContainers === 'number' &&
      raw.maxConcurrentContainers > 0
        ? raw.maxConcurrentContainers
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentContainers,
    maxConcurrentHostProcesses:
      typeof raw.maxConcurrentHostProcesses === 'number' &&
      raw.maxConcurrentHostProcesses > 0
        ? raw.maxConcurrentHostProcesses
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentHostProcesses,
    maxLoginAttempts:
      typeof raw.maxLoginAttempts === 'number' && raw.maxLoginAttempts > 0
        ? raw.maxLoginAttempts
        : DEFAULT_SYSTEM_SETTINGS.maxLoginAttempts,
    loginLockoutMinutes:
      typeof raw.loginLockoutMinutes === 'number' && raw.loginLockoutMinutes > 0
        ? raw.loginLockoutMinutes
        : DEFAULT_SYSTEM_SETTINGS.loginLockoutMinutes,
    maxConcurrentScripts:
      typeof raw.maxConcurrentScripts === 'number' &&
      raw.maxConcurrentScripts > 0
        ? raw.maxConcurrentScripts
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentScripts,
    scriptTimeout:
      typeof raw.scriptTimeout === 'number' && raw.scriptTimeout > 0
        ? raw.scriptTimeout
        : DEFAULT_SYSTEM_SETTINGS.scriptTimeout,
    skillAutoSyncEnabled:
      typeof raw.skillAutoSyncEnabled === 'boolean'
        ? raw.skillAutoSyncEnabled
        : DEFAULT_SYSTEM_SETTINGS.skillAutoSyncEnabled,
    skillAutoSyncIntervalMinutes:
      typeof raw.skillAutoSyncIntervalMinutes === 'number' &&
      raw.skillAutoSyncIntervalMinutes >= 1
        ? raw.skillAutoSyncIntervalMinutes
        : DEFAULT_SYSTEM_SETTINGS.skillAutoSyncIntervalMinutes,
    billingEnabled:
      typeof raw.billingEnabled === 'boolean'
        ? raw.billingEnabled
        : DEFAULT_SYSTEM_SETTINGS.billingEnabled,
    billingMode: 'wallet_first',
    billingMinStartBalanceUsd:
      typeof raw.billingMinStartBalanceUsd === 'number' &&
      raw.billingMinStartBalanceUsd >= 0
        ? raw.billingMinStartBalanceUsd
        : DEFAULT_SYSTEM_SETTINGS.billingMinStartBalanceUsd,
    billingCurrency:
      typeof raw.billingCurrency === 'string' && raw.billingCurrency
        ? raw.billingCurrency
        : DEFAULT_SYSTEM_SETTINGS.billingCurrency,
    billingCurrencyRate:
      typeof raw.billingCurrencyRate === 'number' && raw.billingCurrencyRate > 0
        ? raw.billingCurrencyRate
        : DEFAULT_SYSTEM_SETTINGS.billingCurrencyRate,
  };
}

function buildEnvFallbackSettings(): SystemSettings {
  return {
    defaultRuntime:
      process.env.DEFAULT_RUNTIME &&
      ['codex_app_server'].includes(process.env.DEFAULT_RUNTIME)
        ? normalizeRuntimeType(process.env.DEFAULT_RUNTIME)
        : DEFAULT_SYSTEM_SETTINGS.defaultRuntime,
    containerTimeout: parseIntEnv(
      process.env.CONTAINER_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.containerTimeout,
    ),
    idleTimeout: parseIntEnv(
      process.env.IDLE_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.idleTimeout,
    ),
    containerMaxOutputSize: parseIntEnv(
      process.env.CONTAINER_MAX_OUTPUT_SIZE,
      DEFAULT_SYSTEM_SETTINGS.containerMaxOutputSize,
    ),
    maxConcurrentContainers: parseIntEnv(
      process.env.MAX_CONCURRENT_CONTAINERS,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentContainers,
    ),
    maxConcurrentHostProcesses: parseIntEnv(
      process.env.MAX_CONCURRENT_HOST_PROCESSES,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentHostProcesses,
    ),
    maxLoginAttempts: parseIntEnv(
      process.env.MAX_LOGIN_ATTEMPTS,
      DEFAULT_SYSTEM_SETTINGS.maxLoginAttempts,
    ),
    loginLockoutMinutes: parseIntEnv(
      process.env.LOGIN_LOCKOUT_MINUTES,
      DEFAULT_SYSTEM_SETTINGS.loginLockoutMinutes,
    ),
    maxConcurrentScripts: parseIntEnv(
      process.env.MAX_CONCURRENT_SCRIPTS,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentScripts,
    ),
    scriptTimeout: parseIntEnv(
      process.env.SCRIPT_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.scriptTimeout,
    ),
    skillAutoSyncEnabled:
      process.env.SKILL_AUTO_SYNC_ENABLED === 'true' ||
      DEFAULT_SYSTEM_SETTINGS.skillAutoSyncEnabled,
    skillAutoSyncIntervalMinutes: parseIntEnv(
      process.env.SKILL_AUTO_SYNC_INTERVAL_MINUTES,
      DEFAULT_SYSTEM_SETTINGS.skillAutoSyncIntervalMinutes,
    ),
    billingEnabled:
      process.env.BILLING_ENABLED === 'true' ||
      DEFAULT_SYSTEM_SETTINGS.billingEnabled,
    billingMode: 'wallet_first',
    billingMinStartBalanceUsd: parseFloatEnv(
      process.env.BILLING_MIN_START_BALANCE_USD,
      DEFAULT_SYSTEM_SETTINGS.billingMinStartBalanceUsd,
    ),
    billingCurrency:
      process.env.BILLING_CURRENCY || DEFAULT_SYSTEM_SETTINGS.billingCurrency,
    billingCurrencyRate: parseFloatEnv(
      process.env.BILLING_CURRENCY_RATE,
      DEFAULT_SYSTEM_SETTINGS.billingCurrencyRate,
    ),
  };
}

export function getSystemSettings(): SystemSettings {
  if (settingsCache) {
    try {
      const mtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
      if (mtimeMs === settingsMtimeMs) return settingsCache;
    } catch {
      return settingsCache;
    }
  }

  try {
    const settings = readSystemSettingsFromFile();
    if (settings) {
      settingsCache = settings;
      try {
        settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
      } catch {
        /* ignore */
      }
      return settings;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { err },
        'Failed to read system settings, falling back to env/defaults',
      );
    }
  }

  const settings = buildEnvFallbackSettings();
  settingsCache = settings;
  settingsMtimeMs = 0;
  return settings;
}

export function saveSystemSettings(
  partial: Partial<SystemSettings>,
): SystemSettings {
  const existing = getSystemSettings();
  const merged: SystemSettings = { ...existing, ...partial };

  merged.defaultRuntime = normalizeRuntimeType(merged.defaultRuntime);

  if (merged.containerTimeout < 60000) merged.containerTimeout = 60000;
  if (merged.containerTimeout > 86400000) merged.containerTimeout = 86400000;
  if (merged.idleTimeout < 60000) merged.idleTimeout = 60000;
  if (merged.idleTimeout > 86400000) merged.idleTimeout = 86400000;
  if (merged.containerMaxOutputSize < 1048576)
    merged.containerMaxOutputSize = 1048576;
  if (merged.containerMaxOutputSize > 104857600)
    merged.containerMaxOutputSize = 104857600;
  if (merged.maxConcurrentContainers < 1) merged.maxConcurrentContainers = 1;
  if (merged.maxConcurrentContainers > 100)
    merged.maxConcurrentContainers = 100;
  if (merged.maxConcurrentHostProcesses < 1)
    merged.maxConcurrentHostProcesses = 1;
  if (merged.maxConcurrentHostProcesses > 50)
    merged.maxConcurrentHostProcesses = 50;
  if (merged.maxLoginAttempts < 1) merged.maxLoginAttempts = 1;
  if (merged.maxLoginAttempts > 100) merged.maxLoginAttempts = 100;
  if (merged.loginLockoutMinutes < 1) merged.loginLockoutMinutes = 1;
  if (merged.loginLockoutMinutes > 1440) merged.loginLockoutMinutes = 1440;
  if (merged.maxConcurrentScripts < 1) merged.maxConcurrentScripts = 1;
  if (merged.maxConcurrentScripts > 50) merged.maxConcurrentScripts = 50;
  if (merged.scriptTimeout < 5000) merged.scriptTimeout = 5000;
  if (merged.scriptTimeout > 600000) merged.scriptTimeout = 600000;
  if (merged.skillAutoSyncIntervalMinutes < 1)
    merged.skillAutoSyncIntervalMinutes = 1;
  if (merged.skillAutoSyncIntervalMinutes > 1440)
    merged.skillAutoSyncIntervalMinutes = 1440;
  merged.billingMode = 'wallet_first';
  if (merged.billingMinStartBalanceUsd < 0)
    merged.billingMinStartBalanceUsd =
      DEFAULT_SYSTEM_SETTINGS.billingMinStartBalanceUsd;
  if (merged.billingMinStartBalanceUsd > 1000000)
    merged.billingMinStartBalanceUsd = 1000000;

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${SYSTEM_SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, SYSTEM_SETTINGS_FILE);

  settingsCache = merged;
  try {
    settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
  } catch {
    /* ignore */
  }

  return merged;
}

import type { RuntimeType } from '../shared/types.js';

export interface FeishuProviderConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type FeishuConfigSource = 'runtime' | 'env' | 'none';

export interface FeishuProviderPublicConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  updatedAt: string | null;
  source: FeishuConfigSource;
}

export interface TelegramProviderConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type TelegramConfigSource = 'runtime' | 'env' | 'none';

export interface TelegramProviderPublicConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  proxyUrl: string;
  enabled: boolean;
  updatedAt: string | null;
  source: TelegramConfigSource;
}

export type CodexConfigSource = 'runtime' | 'env' | 'none';

export interface CodexProviderConfig {
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  updatedAt: string | null;
}

export interface CodexProviderPublicConfig {
  hasOpenaiBaseUrl: boolean;
  openaiBaseUrlMasked: string | null;
  openaiModel: string;
  updatedAt: string | null;
  hasOpenaiApiKey: boolean;
  openaiApiKeyMasked: string | null;
  source: CodexConfigSource;
}

export interface ContainerEnvConfig {
  customEnv?: Record<string, string>;
}

export interface ContainerEnvPublicConfig {
  customEnv: Record<string, string>;
}

export interface RegistrationConfig {
  allowRegistration: boolean;
  requireInviteCode: boolean;
  updatedAt: string | null;
}

export interface AppearanceConfig {
  appName: string;
  aiName: string;
  aiAvatarEmoji: string;
  aiAvatarColor: string;
}

export interface UserFeishuConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserTelegramConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserQQConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserWeChatConfig {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  bypassProxy?: boolean;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface SystemSettings {
  defaultRuntime: RuntimeType;
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxConcurrentHostProcesses: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
  skillAutoSyncEnabled: boolean;
  skillAutoSyncIntervalMinutes: number;
  billingEnabled: boolean;
  billingMode: 'wallet_first';
  billingMinStartBalanceUsd: number;
  billingCurrency: string;
  billingCurrencyRate: number;
}

export interface EncryptedSecrets {
  keyId?: string;
  iv: string;
  tag: string;
  data: string;
}

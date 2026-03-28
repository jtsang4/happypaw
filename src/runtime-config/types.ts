import type { RuntimeType } from '../types.js';

export type LegacyProviderMode = 'official' | 'third_party';

export interface LegacyOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface LegacyProviderConfig {
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials: LegacyOAuthCredentials | null;
  anthropicModel: string;
  updatedAt: string | null;
}

export interface LegacyProviderPublicConfig {
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasLegacyCodeOauthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasLegacyOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
}

export interface LegacyThirdPartyProfile {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicModel: string;
  updatedAt: string | null;
  customEnv: Record<string, string>;
}

export interface LegacyThirdPartyProfilePublic {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  customEnv: Record<string, string>;
}

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

export interface BalancingConfig {
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover';
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
}

export interface UnifiedProvider {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicModel: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials: LegacyOAuthCredentials | null;
  customEnv: Record<string, string>;
  updatedAt: string;
}

export interface UnifiedProviderPublic {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  hasAnthropicApiKey: boolean;
  anthropicApiKeyMasked: string | null;
  hasLegacyCodeOauthToken: boolean;
  claudeCodeOauthTokenMasked: string | null;
  hasLegacyOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
  customEnv: Record<string, string>;
  updatedAt: string;
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

export interface LocalLegacyAuthStatus {
  detected: boolean;
  hasCredentials: boolean;
  expiresAt: number | null;
  accessTokenMasked: string | null;
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

export interface SecretPayload {
  anthropicAuthToken: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials?: LegacyOAuthCredentials | null;
}

export interface EncryptedSecrets {
  iv: string;
  tag: string;
  data: string;
}

// ─── 通用类型 ────────────────────────────────────────────────

export interface EnvRow {
  key: string;
  value: string;
}

export interface SessionInfo {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  is_current: boolean;
}

export interface SystemSettings {
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

export type SettingsTab = 'codex' | 'registration' | 'appearance' | 'system' | 'profile' | 'my-channels' | 'security' | 'groups' | 'memory' | 'skills' | 'mcp-servers' | 'agent-definitions' | 'users' | 'about' | 'bindings';

export interface CodexConfigPublic {
  hasOpenaiBaseUrl: boolean;
  openaiBaseUrlMasked: string | null;
  openaiModel: string;
  updatedAt: string | null;
  hasOpenaiApiKey: boolean;
  openaiApiKeyMasked: string | null;
  source: 'runtime' | 'env' | 'none';
}

export interface SetupStatus {
  needsSetup: boolean;
  providerConfigured: boolean;
  codexConfigured: boolean;
  feishuConfigured: boolean;
}

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

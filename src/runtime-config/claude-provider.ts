import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { LEGACY_PRODUCT_NAME } from './shared.js';
import {
  CLAUDE_CONFIG_AUDIT_FILE,
  CLAUDE_CONFIG_FILE,
  CLAUDE_CONFIG_DIR,
  CLAUDE_CUSTOM_ENV_FILE,
  CURRENT_CONFIG_VERSION,
  DEFAULT_THIRD_PARTY_PROFILE_ID,
  DEFAULT_THIRD_PARTY_PROFILE_NAME,
  maskSecret,
  normalizeBaseUrl,
  normalizeModel,
  normalizeProfileId,
  normalizeProfileName,
  normalizeSecret,
  OFFICIAL_CLAUDE_PROFILE_ID,
  sanitizeCustomEnvMap,
} from './shared.js';
import { decryptSecrets, encryptSecrets } from './crypto.js';
import type {
  BalancingConfig,
  ClaudeOAuthCredentials,
  ClaudeProviderConfig,
  ClaudeProviderMode,
  ClaudeProviderPublicConfig,
  ClaudeThirdPartyProfile,
  ClaudeThirdPartyProfilePublic,
  SecretPayload,
  UnifiedProvider,
  UnifiedProviderPublic,
} from './types.js';

interface StoredClaudeProviderConfigV2 {
  version: 2;
  anthropicBaseUrl: string;
  updatedAt: string;
  secrets: ReturnType<typeof encryptSecrets>;
}

interface StoredClaudeThirdPartyProfileV1 {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string;
  secrets: ReturnType<typeof encryptSecrets>;
  customEnv?: Record<string, string>;
}

interface StoredClaudeProviderConfigV3 {
  version: 3;
  activeProfileId: string;
  profiles: StoredClaudeThirdPartyProfileV1[];
  official: {
    updatedAt: string;
    secrets: ReturnType<typeof encryptSecrets>;
    customEnv?: Record<string, string>;
  };
}

interface StoredClaudeProviderConfigLegacy {
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  updatedAt?: string;
}

interface ClaudeStoredStateV3Resolved {
  activeProfileId: string;
  profiles: StoredClaudeThirdPartyProfileV1[];
  officialSecrets: SecretPayload;
  officialUpdatedAt: string | null;
  officialCustomEnv: Record<string, string>;
}

interface ClaudeStoredProfileResolved {
  mode: ClaudeProviderMode;
  profile: ClaudeThirdPartyProfile | null;
  officialSecrets: SecretPayload;
  officialUpdatedAt: string | null;
}

const DEFAULT_BALANCING_CONFIG: BalancingConfig = {
  strategy: 'round-robin',
  unhealthyThreshold: 3,
  recoveryIntervalMs: 300_000,
};

interface StoredProviderV4 {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  secrets: ReturnType<typeof encryptSecrets>;
  customEnv?: Record<string, string>;
  updatedAt: string;
}

interface StoredClaudeProviderConfigV4 {
  version: 4;
  providers: StoredProviderV4[];
  balancing: BalancingConfig;
  updatedAt: string;
}

const MAX_PROVIDERS = 20;
const POOL_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'provider-pool.json');

interface ClaudeConfigAuditEntry {
  timestamp: string;
  actor: string;
  action: string;
  changedFields: string[];
  metadata?: Record<string, unknown>;
}

function normalizeConfig(
  input: Omit<ClaudeProviderConfig, 'updatedAt'>,
): Omit<ClaudeProviderConfig, 'updatedAt'> {
  return {
    anthropicBaseUrl: normalizeBaseUrl(input.anthropicBaseUrl),
    anthropicAuthToken: normalizeSecret(
      input.anthropicAuthToken,
      'anthropicAuthToken',
    ),
    anthropicApiKey: normalizeSecret(input.anthropicApiKey, 'anthropicApiKey'),
    claudeCodeOauthToken: normalizeSecret(
      input.claudeCodeOauthToken,
      'claudeCodeOauthToken',
    ),
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
    anthropicModel: normalizeModel(input.anthropicModel),
  };
}

function buildConfig(
  input: Omit<ClaudeProviderConfig, 'updatedAt'>,
  updatedAt: string | null,
): ClaudeProviderConfig {
  return {
    ...normalizeConfig(input),
    updatedAt,
  };
}

function readLegacyConfig(
  raw: StoredClaudeProviderConfigLegacy,
): ClaudeProviderConfig {
  return buildConfig(
    {
      anthropicBaseUrl: raw.anthropicBaseUrl ?? '',
      anthropicAuthToken: raw.anthropicAuthToken ?? '',
      anthropicApiKey: raw.anthropicApiKey ?? '',
      claudeCodeOauthToken: raw.claudeCodeOauthToken ?? '',
      claudeOAuthCredentials: null,
      anthropicModel: process.env.ANTHROPIC_MODEL || '',
    },
    typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  );
}

function toStoredProfile(
  profile: ClaudeThirdPartyProfile,
): StoredClaudeThirdPartyProfileV1 {
  const sanitizedEnv = sanitizeCustomEnvMap(profile.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
  return {
    id: normalizeProfileId(profile.id),
    name: normalizeProfileName(profile.name),
    anthropicBaseUrl: normalizeBaseUrl(profile.anthropicBaseUrl),
    anthropicModel: normalizeModel(profile.anthropicModel),
    updatedAt: profile.updatedAt || new Date().toISOString(),
    secrets: encryptSecrets({
      anthropicAuthToken: normalizeSecret(
        profile.anthropicAuthToken,
        'anthropicAuthToken',
      ),
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    }),
    ...(Object.keys(sanitizedEnv).length > 0
      ? { customEnv: sanitizedEnv }
      : {}),
  };
}

function fromStoredProfile(
  stored: StoredClaudeThirdPartyProfileV1,
): ClaudeThirdPartyProfile {
  const secrets = decryptSecrets(stored.secrets);
  return {
    id: normalizeProfileId(stored.id),
    name: normalizeProfileName(stored.name),
    anthropicBaseUrl: normalizeBaseUrl(stored.anthropicBaseUrl),
    anthropicAuthToken: secrets.anthropicAuthToken,
    anthropicModel: normalizeModel(
      stored.anthropicModel ??
        (stored as unknown as Record<string, string | undefined>)[
          `${LEGACY_PRODUCT_NAME.toLowerCase()}Model`
        ] ??
        '',
    ),
    updatedAt: stored.updatedAt || null,
    customEnv: sanitizeCustomEnvMap(stored.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
  };
}

function makeDefaultThirdPartyProfile(
  config: ClaudeProviderConfig,
): ClaudeThirdPartyProfile {
  return {
    id: DEFAULT_THIRD_PARTY_PROFILE_ID,
    name: DEFAULT_THIRD_PARTY_PROFILE_NAME,
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicAuthToken: config.anthropicAuthToken,
    anthropicModel: normalizeModel(
      config.anthropicModel || process.env.ANTHROPIC_MODEL || '',
    ),
    updatedAt: config.updatedAt || new Date().toISOString(),
    customEnv: {},
  };
}

function normalizeOfficialSecrets(input: SecretPayload): SecretPayload {
  return {
    anthropicAuthToken: '',
    anthropicApiKey: normalizeSecret(
      input.anthropicApiKey ?? '',
      'anthropicApiKey',
    ),
    claudeCodeOauthToken: normalizeSecret(
      input.claudeCodeOauthToken ?? '',
      'claudeCodeOauthToken',
    ),
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
  };
}

function isOfficialClaudeMode(activeProfileId: string): boolean {
  return activeProfileId === OFFICIAL_CLAUDE_PROFILE_ID;
}

function buildOfficialClaudeProviderConfig(
  officialSecrets: SecretPayload,
  officialUpdatedAt: string | null,
): ClaudeProviderConfig {
  return buildConfig(
    {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials: officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: '',
    },
    officialUpdatedAt,
  );
}

function normalizeStoredState(
  state: ClaudeStoredStateV3Resolved,
): ClaudeStoredStateV3Resolved {
  const normalizedProfiles = state.profiles
    .map((item) => fromStoredProfile(item))
    .slice(0, 20)
    .map((profile) => toStoredProfile(profile));

  const officialSecrets = normalizeOfficialSecrets(state.officialSecrets);
  const officialMode = isOfficialClaudeMode(state.activeProfileId);
  let officialCustomEnv = sanitizeCustomEnvMap(state.officialCustomEnv || {}, {
    skipReservedClaudeKeys: true,
  });

  const allEmpty =
    Object.keys(officialCustomEnv).length === 0 &&
    normalizedProfiles.every(
      (p) => !p.customEnv || Object.keys(p.customEnv).length === 0,
    );
  if (allEmpty) {
    try {
      if (fs.existsSync(CLAUDE_CUSTOM_ENV_FILE)) {
        const parsed = JSON.parse(
          fs.readFileSync(CLAUDE_CUSTOM_ENV_FILE, 'utf-8'),
        ) as { customEnv?: Record<string, string> };
        const legacyEnv = sanitizeCustomEnvMap(parsed.customEnv || {}, {
          skipReservedClaudeKeys: true,
        });
        if (Object.keys(legacyEnv).length > 0) {
          if (officialMode) {
            officialCustomEnv = legacyEnv;
          } else {
            const activeIdx = normalizedProfiles.findIndex(
              (p) => p.id === state.activeProfileId,
            );
            if (activeIdx >= 0) {
              normalizedProfiles[activeIdx] = {
                ...normalizedProfiles[activeIdx],
                customEnv: legacyEnv,
              };
            }
          }
          logger.info('Migrated legacy global customEnv to active profile');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to migrate legacy global customEnv');
    }
  }

  if (normalizedProfiles.length === 0) {
    if (officialMode) {
      return {
        activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
        profiles: [],
        officialSecrets,
        officialUpdatedAt: state.officialUpdatedAt,
        officialCustomEnv,
      };
    }

    const defaultProfile = toStoredProfile(
      makeDefaultThirdPartyProfile({
        anthropicBaseUrl: '',
        anthropicAuthToken: '',
        anthropicApiKey: '',
        claudeCodeOauthToken: '',
        claudeOAuthCredentials: null,
        anthropicModel: process.env.ANTHROPIC_MODEL || '',
        updatedAt: null,
      }),
    );
    return {
      activeProfileId: defaultProfile.id,
      profiles: [defaultProfile],
      officialSecrets,
      officialUpdatedAt: state.officialUpdatedAt,
      officialCustomEnv,
    };
  }

  const hasActive = normalizedProfiles.some(
    (item) => item.id === state.activeProfileId,
  );
  const activeProfileId = officialMode
    ? OFFICIAL_CLAUDE_PROFILE_ID
    : hasActive
      ? state.activeProfileId
      : normalizedProfiles[0].id;

  return {
    activeProfileId,
    profiles: normalizedProfiles,
    officialSecrets,
    officialUpdatedAt: state.officialUpdatedAt,
    officialCustomEnv,
  };
}

function readStoredState(): ClaudeStoredStateV3Resolved | null {
  if (!fs.existsSync(CLAUDE_CONFIG_FILE)) return null;
  try {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    if (parsed.version === 3) {
      const v3 = parsed as unknown as StoredClaudeProviderConfigV3;
      const profiles = Array.isArray(v3.profiles) ? v3.profiles : [];
      const officialSecrets = v3.official
        ? decryptSecrets(v3.official.secrets)
        : {
            anthropicAuthToken: '',
            anthropicApiKey: '',
            claudeCodeOauthToken: '',
            claudeOAuthCredentials: null,
          };
      return normalizeStoredState({
        activeProfileId:
          typeof v3.activeProfileId === 'string'
            ? isOfficialClaudeMode(v3.activeProfileId)
              ? OFFICIAL_CLAUDE_PROFILE_ID
              : normalizeProfileId(v3.activeProfileId)
            : DEFAULT_THIRD_PARTY_PROFILE_ID,
        profiles: profiles as StoredClaudeThirdPartyProfileV1[],
        officialSecrets,
        officialUpdatedAt: v3.official?.updatedAt || null,
        officialCustomEnv: v3.official?.customEnv || {},
      });
    }

    if (parsed.version === 2) {
      const v2 = parsed as unknown as StoredClaudeProviderConfigV2;
      const secrets = decryptSecrets(v2.secrets);
      const legacyConfig = buildConfig(
        {
          anthropicBaseUrl: v2.anthropicBaseUrl,
          anthropicAuthToken: secrets.anthropicAuthToken,
          anthropicApiKey: secrets.anthropicApiKey,
          claudeCodeOauthToken: secrets.claudeCodeOauthToken,
          claudeOAuthCredentials: secrets.claudeOAuthCredentials ?? null,
          anthropicModel: process.env.ANTHROPIC_MODEL || '',
        },
        v2.updatedAt || null,
      );
      const profile = toStoredProfile(
        makeDefaultThirdPartyProfile(legacyConfig),
      );
      return normalizeStoredState({
        activeProfileId: profile.id,
        profiles: [profile],
        officialSecrets: {
          anthropicAuthToken: '',
          anthropicApiKey: legacyConfig.anthropicApiKey,
          claudeCodeOauthToken: legacyConfig.claudeCodeOauthToken,
          claudeOAuthCredentials: legacyConfig.claudeOAuthCredentials,
        },
        officialUpdatedAt: legacyConfig.updatedAt,
        officialCustomEnv: {},
      });
    }

    const legacy = readLegacyConfig(parsed as StoredClaudeProviderConfigLegacy);
    const profile = toStoredProfile(makeDefaultThirdPartyProfile(legacy));
    return normalizeStoredState({
      activeProfileId: profile.id,
      profiles: [profile],
      officialSecrets: {
        anthropicAuthToken: '',
        anthropicApiKey: legacy.anthropicApiKey,
        claudeCodeOauthToken: legacy.claudeCodeOauthToken,
        claudeOAuthCredentials: legacy.claudeOAuthCredentials,
      },
      officialUpdatedAt: legacy.updatedAt,
      officialCustomEnv: {},
    });
  } catch (err) {
    logger.error(
      { err, file: CLAUDE_CONFIG_FILE },
      'Failed to read Claude provider config, falling back to defaults',
    );
    return null;
  }
}

function writeStoredState(state: ClaudeStoredStateV3Resolved): void {
  const normalized = normalizeStoredState(state);
  const payload: StoredClaudeProviderConfigV3 = {
    version: CURRENT_CONFIG_VERSION,
    activeProfileId: normalized.activeProfileId,
    profiles: normalized.profiles,
    official: {
      updatedAt: normalized.officialUpdatedAt || new Date().toISOString(),
      secrets: encryptSecrets({
        anthropicAuthToken: '',
        anthropicApiKey: normalized.officialSecrets.anthropicApiKey,
        claudeCodeOauthToken: normalized.officialSecrets.claudeCodeOauthToken,
        claudeOAuthCredentials:
          normalized.officialSecrets.claudeOAuthCredentials,
      }),
      ...(Object.keys(normalized.officialCustomEnv || {}).length > 0
        ? { customEnv: normalized.officialCustomEnv }
        : {}),
    },
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${CLAUDE_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, CLAUDE_CONFIG_FILE);
}

function toStoredProviderV4(provider: UnifiedProvider): StoredProviderV4 {
  const secrets: SecretPayload = {
    anthropicAuthToken: provider.anthropicAuthToken || '',
    anthropicApiKey: provider.anthropicApiKey || '',
    claudeCodeOauthToken: provider.claudeCodeOauthToken || '',
    claudeOAuthCredentials: provider.claudeOAuthCredentials ?? null,
  };
  const sanitizedEnv = sanitizeCustomEnvMap(provider.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    enabled: provider.enabled,
    weight: Math.max(1, Math.min(100, provider.weight || 1)),
    anthropicBaseUrl: provider.anthropicBaseUrl || '',
    anthropicModel: provider.anthropicModel || '',
    secrets: encryptSecrets(secrets),
    ...(Object.keys(sanitizedEnv).length > 0
      ? { customEnv: sanitizedEnv }
      : {}),
    updatedAt: provider.updatedAt || new Date().toISOString(),
  };
}

function fromStoredProviderV4(stored: StoredProviderV4): UnifiedProvider {
  const secrets = decryptSecrets(stored.secrets);
  return {
    id: stored.id,
    name: stored.name,
    type: stored.type,
    enabled: stored.enabled,
    weight: Math.max(1, Math.min(100, stored.weight || 1)),
    anthropicBaseUrl: stored.anthropicBaseUrl || '',
    anthropicAuthToken: secrets.anthropicAuthToken || '',
    anthropicModel: stored.anthropicModel || '',
    anthropicApiKey: secrets.anthropicApiKey || '',
    claudeCodeOauthToken: secrets.claudeCodeOauthToken || '',
    claudeOAuthCredentials: secrets.claudeOAuthCredentials ?? null,
    customEnv: sanitizeCustomEnvMap(stored.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
    updatedAt: stored.updatedAt || '',
  };
}

function migrateV3toV4(v3: ClaudeStoredStateV3Resolved): {
  providers: UnifiedProvider[];
  balancing: BalancingConfig;
} {
  const providers: UnifiedProvider[] = [];
  const now = new Date().toISOString();

  const hasOfficial =
    !!v3.officialSecrets.anthropicApiKey ||
    !!v3.officialSecrets.claudeCodeOauthToken ||
    !!v3.officialSecrets.claudeOAuthCredentials;
  if (hasOfficial) {
    providers.push({
      id: OFFICIAL_CLAUDE_PROFILE_ID,
      name: '官方 Claude',
      type: 'official',
      enabled: isOfficialClaudeMode(v3.activeProfileId),
      weight: 1,
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicModel: '',
      anthropicApiKey: v3.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: v3.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials: v3.officialSecrets.claudeOAuthCredentials ?? null,
      customEnv: v3.officialCustomEnv || {},
      updatedAt: v3.officialUpdatedAt || now,
    });
  }

  for (const stored of v3.profiles) {
    const profile = fromStoredProfile(stored);
    providers.push({
      id: profile.id,
      name: profile.name,
      type: 'third_party',
      enabled: profile.id === v3.activeProfileId,
      weight: 1,
      anthropicBaseUrl: profile.anthropicBaseUrl,
      anthropicAuthToken: profile.anthropicAuthToken,
      anthropicModel: profile.anthropicModel,
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
      customEnv: profile.customEnv || {},
      updatedAt: profile.updatedAt || now,
    });
  }

  let balancing: BalancingConfig = { ...DEFAULT_BALANCING_CONFIG };
  try {
    if (fs.existsSync(POOL_CONFIG_FILE)) {
      const poolContent = fs.readFileSync(POOL_CONFIG_FILE, 'utf-8');
      const pool = JSON.parse(poolContent) as Record<string, unknown>;
      if (pool.version === 1 && pool.mode === 'pool') {
        const members = pool.members as Array<{
          profileId: string;
          weight: number;
          enabled: boolean;
        }>;
        if (Array.isArray(members)) {
          for (const member of members) {
            const p = providers.find((pv) => pv.id === member.profileId);
            if (p) {
              p.enabled = member.enabled;
              p.weight = Math.max(1, Math.min(100, member.weight || 1));
            }
          }
        }
        if (
          typeof pool.strategy === 'string' &&
          ['round-robin', 'weighted-round-robin', 'failover'].includes(
            pool.strategy,
          )
        ) {
          balancing.strategy = pool.strategy as BalancingConfig['strategy'];
        }
        if (typeof pool.unhealthyThreshold === 'number') {
          balancing.unhealthyThreshold = pool.unhealthyThreshold;
        }
        if (typeof pool.recoveryIntervalMs === 'number') {
          balancing.recoveryIntervalMs = pool.recoveryIntervalMs;
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read provider-pool.json during migration');
  }

  if (providers.length > 0 && !providers.some((p) => p.enabled)) {
    providers[0].enabled = true;
  }

  return { providers, balancing };
}

function readStoredStateV4(): {
  providers: UnifiedProvider[];
  balancing: BalancingConfig;
} | null {
  if (!fs.existsSync(CLAUDE_CONFIG_FILE)) return null;
  try {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    if (parsed.version === 4) {
      const v4 = parsed as unknown as StoredClaudeProviderConfigV4;
      return {
        providers: v4.providers.map(fromStoredProviderV4),
        balancing: {
          strategy: v4.balancing?.strategy || DEFAULT_BALANCING_CONFIG.strategy,
          unhealthyThreshold:
            v4.balancing?.unhealthyThreshold ??
            DEFAULT_BALANCING_CONFIG.unhealthyThreshold,
          recoveryIntervalMs:
            v4.balancing?.recoveryIntervalMs ??
            DEFAULT_BALANCING_CONFIG.recoveryIntervalMs,
        },
      };
    }

    const v3 = readStoredState();
    if (!v3) return null;

    const migrated = migrateV3toV4(v3);
    writeStoredStateV4(migrated.providers, migrated.balancing);
    logger.info(
      { providerCount: migrated.providers.length },
      'Migrated Claude provider config from V3 to V4',
    );

    return migrated;
  } catch (err) {
    logger.error(
      { err, file: CLAUDE_CONFIG_FILE },
      'Failed to read Claude provider config V4',
    );
    return null;
  }
}

function writeStoredStateV4(
  providers: UnifiedProvider[],
  balancing: BalancingConfig,
): void {
  const payload: StoredClaudeProviderConfigV4 = {
    version: 4,
    providers: providers.map(toStoredProviderV4),
    balancing,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${CLAUDE_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, CLAUDE_CONFIG_FILE);
}

export function getProviders(): UnifiedProvider[] {
  const state = readStoredStateV4();
  return state?.providers ?? [];
}

export function getEnabledProviders(): UnifiedProvider[] {
  return getProviders().filter((p) => p.enabled);
}

export function getBalancingConfig(): BalancingConfig {
  const state = readStoredStateV4();
  return state?.balancing ?? { ...DEFAULT_BALANCING_CONFIG };
}

export function saveBalancingConfig(
  config: Partial<BalancingConfig>,
): BalancingConfig {
  const state = readStoredStateV4() || {
    providers: [],
    balancing: { ...DEFAULT_BALANCING_CONFIG },
  };
  const merged: BalancingConfig = {
    ...state.balancing,
    ...config,
  };
  writeStoredStateV4(state.providers, merged);
  return merged;
}

export function createProvider(input: {
  name: string;
  type: 'official' | 'third_party';
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicModel?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
  customEnv?: Record<string, string>;
  weight?: number;
  enabled?: boolean;
}): UnifiedProvider {
  const state = readStoredStateV4() || {
    providers: [],
    balancing: { ...DEFAULT_BALANCING_CONFIG },
  };

  if (state.providers.length >= MAX_PROVIDERS) {
    throw new Error(`最多只能创建 ${MAX_PROVIDERS} 个供应商`);
  }

  const now = new Date().toISOString();
  const provider: UnifiedProvider = {
    id: crypto.randomBytes(8).toString('hex'),
    name: normalizeProfileName(input.name),
    type: input.type,
    enabled: input.enabled ?? state.providers.length === 0,
    weight: Math.max(1, Math.min(100, input.weight ?? 1)),
    anthropicBaseUrl: input.anthropicBaseUrl
      ? normalizeBaseUrl(input.anthropicBaseUrl)
      : '',
    anthropicAuthToken: input.anthropicAuthToken
      ? normalizeSecret(input.anthropicAuthToken, 'anthropicAuthToken')
      : '',
    anthropicModel: input.anthropicModel
      ? normalizeModel(input.anthropicModel)
      : '',
    anthropicApiKey: input.anthropicApiKey
      ? normalizeSecret(input.anthropicApiKey, 'anthropicApiKey')
      : '',
    claudeCodeOauthToken: input.claudeCodeOauthToken
      ? normalizeSecret(input.claudeCodeOauthToken, 'claudeCodeOauthToken')
      : '',
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
    customEnv: sanitizeCustomEnvMap(input.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
    updatedAt: now,
  };

  state.providers.push(provider);
  writeStoredStateV4(state.providers, state.balancing);
  return provider;
}

export function updateProvider(
  id: string,
  patch: {
    name?: string;
    anthropicBaseUrl?: string;
    anthropicModel?: string;
    customEnv?: Record<string, string>;
    weight?: number;
  },
): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const current = state.providers[idx];
  const updated: UnifiedProvider = {
    ...current,
    ...(patch.name !== undefined
      ? { name: normalizeProfileName(patch.name) }
      : {}),
    ...(patch.anthropicBaseUrl !== undefined
      ? { anthropicBaseUrl: normalizeBaseUrl(patch.anthropicBaseUrl) }
      : {}),
    ...(patch.anthropicModel !== undefined
      ? { anthropicModel: normalizeModel(patch.anthropicModel) }
      : {}),
    ...(patch.customEnv !== undefined
      ? {
          customEnv: sanitizeCustomEnvMap(patch.customEnv, {
            skipReservedClaudeKeys: true,
          }),
        }
      : {}),
    ...(patch.weight !== undefined
      ? { weight: Math.max(1, Math.min(100, patch.weight)) }
      : {}),
    updatedAt: new Date().toISOString(),
  };

  state.providers[idx] = updated;
  writeStoredStateV4(state.providers, state.balancing);
  return updated;
}

export function updateProviderSecrets(
  id: string,
  secrets: {
    anthropicAuthToken?: string;
    clearAnthropicAuthToken?: boolean;
    anthropicApiKey?: string;
    clearAnthropicApiKey?: boolean;
    claudeCodeOauthToken?: string;
    clearClaudeCodeOauthToken?: boolean;
    claudeOAuthCredentials?: ClaudeOAuthCredentials;
    clearClaudeOAuthCredentials?: boolean;
  },
): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const current = state.providers[idx];
  const updated = { ...current, updatedAt: new Date().toISOString() };

  if (typeof secrets.anthropicAuthToken === 'string') {
    updated.anthropicAuthToken = normalizeSecret(
      secrets.anthropicAuthToken,
      'anthropicAuthToken',
    );
  } else if (secrets.clearAnthropicAuthToken) {
    updated.anthropicAuthToken = '';
  }

  if (typeof secrets.anthropicApiKey === 'string') {
    updated.anthropicApiKey = normalizeSecret(
      secrets.anthropicApiKey,
      'anthropicApiKey',
    );
  } else if (secrets.clearAnthropicApiKey) {
    updated.anthropicApiKey = '';
  }

  if (typeof secrets.claudeCodeOauthToken === 'string') {
    updated.claudeCodeOauthToken = normalizeSecret(
      secrets.claudeCodeOauthToken,
      'claudeCodeOauthToken',
    );
  } else if (secrets.clearClaudeCodeOauthToken) {
    updated.claudeCodeOauthToken = '';
  }

  if (secrets.claudeOAuthCredentials) {
    updated.claudeOAuthCredentials = secrets.claudeOAuthCredentials;
    updated.claudeCodeOauthToken = '';
  } else if (secrets.clearClaudeOAuthCredentials) {
    updated.claudeOAuthCredentials = null;
  }

  state.providers[idx] = updated;
  writeStoredStateV4(state.providers, state.balancing);
  return updated;
}

export function toggleProvider(id: string): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const provider = state.providers[idx];
  const newEnabled = !provider.enabled;

  if (!newEnabled && state.providers.filter((p) => p.enabled).length <= 1) {
    throw new Error('至少需要保留一个启用的供应商');
  }

  state.providers[idx] = {
    ...provider,
    enabled: newEnabled,
    updatedAt: new Date().toISOString(),
  };
  writeStoredStateV4(state.providers, state.balancing);
  return state.providers[idx];
}

export function deleteProvider(id: string): void {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  if (state.providers.length <= 1) {
    throw new Error('至少需要保留一个供应商');
  }

  const wasEnabled = state.providers[idx].enabled;
  state.providers.splice(idx, 1);

  if (wasEnabled && !state.providers.some((p) => p.enabled)) {
    state.providers[0].enabled = true;
  }

  writeStoredStateV4(state.providers, state.balancing);
}

export function providerToConfig(
  provider: UnifiedProvider,
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: provider.anthropicBaseUrl,
    anthropicAuthToken: provider.anthropicAuthToken,
    anthropicApiKey: provider.anthropicApiKey,
    claudeCodeOauthToken: provider.claudeCodeOauthToken,
    claudeOAuthCredentials: provider.claudeOAuthCredentials,
    anthropicModel: provider.anthropicModel,
    updatedAt: provider.updatedAt,
  };
}

export function toPublicProvider(
  provider: UnifiedProvider,
): UnifiedProviderPublic {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    enabled: provider.enabled,
    weight: provider.weight,
    anthropicBaseUrl: provider.anthropicBaseUrl,
    anthropicModel: provider.anthropicModel,
    hasAnthropicAuthToken: !!provider.anthropicAuthToken,
    anthropicAuthTokenMasked: maskSecret(provider.anthropicAuthToken),
    hasAnthropicApiKey: !!provider.anthropicApiKey,
    anthropicApiKeyMasked: maskSecret(provider.anthropicApiKey),
    hasClaudeCodeOauthToken: !!provider.claudeCodeOauthToken,
    claudeCodeOauthTokenMasked: maskSecret(provider.claudeCodeOauthToken),
    hasClaudeOAuthCredentials: !!provider.claudeOAuthCredentials,
    claudeOAuthCredentialsExpiresAt:
      provider.claudeOAuthCredentials?.expiresAt ?? null,
    claudeOAuthCredentialsAccessTokenMasked: provider.claudeOAuthCredentials
      ? maskSecret(provider.claudeOAuthCredentials.accessToken)
      : null,
    customEnv: provider.customEnv || {},
    updatedAt: provider.updatedAt,
  };
}

export function resolveProviderById(providerId: string): {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
} {
  const state = readStoredStateV4();
  if (!state) return { config: defaultsFromEnv(), customEnv: {} };

  const provider = state.providers.find((p) => p.id === providerId);
  if (!provider) {
    logger.warn(
      { providerId },
      'resolveProviderById: provider not found, falling back to first enabled',
    );

    const fallback =
      state.providers.find((p) => p.enabled) || state.providers[0];
    if (!fallback) return { config: defaultsFromEnv(), customEnv: {} };
    return {
      config: providerToConfig(fallback),
      customEnv: fallback.customEnv,
    };
  }

  return {
    config: providerToConfig(provider),
    customEnv: provider.customEnv,
  };
}

function resolveActiveProfile(
  state: ClaudeStoredStateV3Resolved,
): ClaudeStoredProfileResolved {
  if (isOfficialClaudeMode(state.activeProfileId)) {
    return {
      mode: 'official',
      profile: null,
      officialSecrets: state.officialSecrets,
      officialUpdatedAt: state.officialUpdatedAt,
    };
  }

  const active =
    state.profiles.find((item) => item.id === state.activeProfileId) ||
    state.profiles[0];
  if (!active) {
    return {
      mode: 'official',
      profile: null,
      officialSecrets: state.officialSecrets,
      officialUpdatedAt: state.officialUpdatedAt,
    };
  }

  const profile = fromStoredProfile(active);
  return {
    mode: 'third_party',
    profile,
    officialSecrets: state.officialSecrets,
    officialUpdatedAt: state.officialUpdatedAt,
  };
}

function defaultsFromEnv(): ClaudeProviderConfig {
  const raw = {
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
    claudeOAuthCredentials: null,
    anthropicModel: process.env.ANTHROPIC_MODEL || '',
  };

  try {
    return buildConfig(raw, null);
  } catch {
    return {
      anthropicBaseUrl: '',
      anthropicAuthToken: raw.anthropicAuthToken.trim(),
      anthropicApiKey: raw.anthropicApiKey.trim(),
      claudeCodeOauthToken: raw.claudeCodeOauthToken.trim(),
      claudeOAuthCredentials: null,
      anthropicModel: raw.anthropicModel.trim(),
      updatedAt: null,
    };
  }
}

export function getClaudeProviderConfig(): ClaudeProviderConfig {
  try {
    const state = readStoredStateV4();
    if (state) {
      const enabled =
        state.providers.find((p) => p.enabled) || state.providers[0];
      if (enabled) return providerToConfig(enabled);
    }
  } catch {
    // ignore corrupted file and use env fallback
  }
  return defaultsFromEnv();
}

export function toPublicClaudeProviderConfig(
  config: ClaudeProviderConfig,
): ClaudeProviderPublicConfig {
  return {
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicModel: config.anthropicModel,
    updatedAt: config.updatedAt,
    hasAnthropicAuthToken: !!config.anthropicAuthToken,
    hasAnthropicApiKey: !!config.anthropicApiKey,
    hasClaudeCodeOauthToken: !!config.claudeCodeOauthToken,
    anthropicAuthTokenMasked: maskSecret(config.anthropicAuthToken),
    anthropicApiKeyMasked: maskSecret(config.anthropicApiKey),
    claudeCodeOauthTokenMasked: maskSecret(config.claudeCodeOauthToken),
    hasClaudeOAuthCredentials: !!config.claudeOAuthCredentials,
    claudeOAuthCredentialsExpiresAt:
      config.claudeOAuthCredentials?.expiresAt ?? null,
    claudeOAuthCredentialsAccessTokenMasked: config.claudeOAuthCredentials
      ? maskSecret(config.claudeOAuthCredentials.accessToken)
      : null,
  };
}

export function validateClaudeProviderConfig(
  config: ClaudeProviderConfig,
): string[] {
  const errors: string[] = [];

  if (config.anthropicAuthToken && !config.anthropicBaseUrl) {
    errors.push('使用 ANTHROPIC_AUTH_TOKEN 时必须配置 ANTHROPIC_BASE_URL');
  }

  if (config.anthropicBaseUrl) {
    try {
      const parsed = new URL(config.anthropicBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push('ANTHROPIC_BASE_URL 必须是 http 或 https 地址');
      }
    } catch {
      errors.push('ANTHROPIC_BASE_URL 格式不正确');
    }
  }

  return errors;
}

export function saveClaudeProviderConfig(
  next: Omit<ClaudeProviderConfig, 'updatedAt'>,
  options?: { mode?: ClaudeProviderMode },
): ClaudeProviderConfig {
  const normalized = buildConfig(next, new Date().toISOString());
  const errors = validateClaudeProviderConfig(normalized);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  const mode =
    options?.mode ?? (normalized.anthropicBaseUrl ? 'third_party' : 'official');
  const existing = readStoredState();
  const baseState: ClaudeStoredStateV3Resolved = existing || {
    activeProfileId:
      mode === 'official'
        ? OFFICIAL_CLAUDE_PROFILE_ID
        : DEFAULT_THIRD_PARTY_PROFILE_ID,
    profiles:
      mode === 'official'
        ? []
        : [
            toStoredProfile(
              makeDefaultThirdPartyProfile({
                anthropicBaseUrl: normalized.anthropicBaseUrl,
                anthropicAuthToken: normalized.anthropicAuthToken,
                anthropicApiKey: normalized.anthropicApiKey,
                claudeCodeOauthToken: normalized.claudeCodeOauthToken,
                claudeOAuthCredentials: normalized.claudeOAuthCredentials,
                anthropicModel: normalized.anthropicModel,
                updatedAt: normalized.updatedAt,
              }),
            ),
          ],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: normalized.updatedAt,
    officialCustomEnv: {},
  };

  if (mode === 'official') {
    const officialSecrets = normalizeOfficialSecrets({
      anthropicAuthToken: '',
      anthropicApiKey: normalized.anthropicApiKey,
      claudeCodeOauthToken: normalized.claudeCodeOauthToken,
      claudeOAuthCredentials: normalized.claudeOAuthCredentials,
    });

    writeStoredState({
      ...baseState,
      activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
      officialSecrets,
      officialUpdatedAt: normalized.updatedAt,
    });

    return buildOfficialClaudeProviderConfig(
      officialSecrets,
      normalized.updatedAt,
    );
  }

  const activeId = isOfficialClaudeMode(baseState.activeProfileId)
    ? null
    : baseState.activeProfileId;
  const activeStored =
    (activeId
      ? baseState.profiles.find((item) => item.id === activeId)
      : undefined) || baseState.profiles[0];

  const activeProfile = activeStored
    ? fromStoredProfile(activeStored)
    : makeDefaultThirdPartyProfile(normalized);

  const updatedProfile: ClaudeThirdPartyProfile = {
    ...activeProfile,
    anthropicBaseUrl: normalized.anthropicBaseUrl,
    anthropicAuthToken: normalized.anthropicAuthToken,
    anthropicModel: normalized.anthropicModel,
    updatedAt: normalized.updatedAt,
  };

  const updatedProfiles = baseState.profiles.length
    ? baseState.profiles.map((item) =>
        item.id === updatedProfile.id ? toStoredProfile(updatedProfile) : item,
      )
    : [toStoredProfile(updatedProfile)];

  writeStoredState({
    activeProfileId: updatedProfile.id,
    profiles: updatedProfiles,
    officialSecrets: normalizeOfficialSecrets({
      anthropicAuthToken: '',
      anthropicApiKey: normalized.anthropicApiKey,
      claudeCodeOauthToken: normalized.claudeCodeOauthToken,
      claudeOAuthCredentials: normalized.claudeOAuthCredentials,
    }),
    officialUpdatedAt: normalized.updatedAt,
    officialCustomEnv: baseState.officialCustomEnv,
  });

  return normalized;
}

export function saveClaudeOfficialProviderSecrets(
  next: Pick<
    ClaudeProviderConfig,
    'anthropicApiKey' | 'claudeCodeOauthToken' | 'claudeOAuthCredentials'
  >,
  options?: { activateOfficial?: boolean },
): ClaudeProviderConfig {
  const updatedAt = new Date().toISOString();
  const officialSecrets = normalizeOfficialSecrets({
    anthropicAuthToken: '',
    anthropicApiKey: next.anthropicApiKey,
    claudeCodeOauthToken: next.claudeCodeOauthToken,
    claudeOAuthCredentials: next.claudeOAuthCredentials,
  });

  const existing = readStoredState();
  const baseState: ClaudeStoredStateV3Resolved = existing || {
    activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
    profiles: [],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: null,
    officialCustomEnv: {},
  };

  writeStoredState({
    ...baseState,
    activeProfileId: options?.activateOfficial
      ? OFFICIAL_CLAUDE_PROFILE_ID
      : baseState.activeProfileId,
    officialSecrets,
    officialUpdatedAt: updatedAt,
  });

  return getClaudeProviderConfig();
}

export function listClaudeThirdPartyProfiles(): {
  activeProfileId: string;
  profiles: ClaudeThirdPartyProfile[];
} {
  const state = readStoredState();
  if (!state) {
    const fallback = defaultsFromEnv();
    const profile = makeDefaultThirdPartyProfile(fallback);
    return {
      activeProfileId: profile.id,
      profiles: [profile],
    };
  }

  return {
    activeProfileId: state.activeProfileId,
    profiles: state.profiles.map((item) => fromStoredProfile(item)),
  };
}

export function toPublicClaudeThirdPartyProfile(
  profile: ClaudeThirdPartyProfile,
): ClaudeThirdPartyProfilePublic {
  return {
    id: profile.id,
    name: profile.name,
    anthropicBaseUrl: profile.anthropicBaseUrl,
    anthropicModel: profile.anthropicModel,
    updatedAt: profile.updatedAt,
    hasAnthropicAuthToken: !!profile.anthropicAuthToken,
    anthropicAuthTokenMasked: maskSecret(profile.anthropicAuthToken),
    customEnv: profile.customEnv || {},
  };
}

export function createClaudeThirdPartyProfile(input: {
  name: string;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicModel?: string;
  customEnv?: Record<string, string>;
}): ClaudeThirdPartyProfile {
  const state = readStoredState() || {
    activeProfileId: DEFAULT_THIRD_PARTY_PROFILE_ID,
    profiles: [],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: null,
    officialCustomEnv: {},
  };

  if (state.profiles.length >= 20) {
    throw new Error('最多只能创建 20 个第三方配置');
  }

  const now = new Date().toISOString();
  const profile: ClaudeThirdPartyProfile = {
    id: crypto.randomBytes(8).toString('hex'),
    name: normalizeProfileName(input.name),
    anthropicBaseUrl: normalizeBaseUrl(input.anthropicBaseUrl),
    anthropicAuthToken: normalizeSecret(
      input.anthropicAuthToken,
      'anthropicAuthToken',
    ),
    anthropicModel: normalizeModel(input.anthropicModel ?? ''),
    updatedAt: now,
    customEnv: sanitizeCustomEnvMap(input.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: profile.anthropicBaseUrl,
      anthropicAuthToken: profile.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: profile.anthropicModel,
    },
    now,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    activeProfileId:
      state.profiles.length === 0 ? profile.id : state.activeProfileId,
    profiles: [...state.profiles, toStoredProfile(profile)],
  });

  return profile;
}

export function updateClaudeThirdPartyProfile(
  profileId: string,
  patch: {
    name?: string;
    anthropicBaseUrl?: string;
    anthropicModel?: string;
    customEnv?: Record<string, string>;
  },
): ClaudeThirdPartyProfile {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const current = state.profiles.find((item) => item.id === id);
  if (!current) throw new Error('未找到指定第三方配置');

  const decoded = fromStoredProfile(current);
  const next: ClaudeThirdPartyProfile = {
    ...decoded,
    name:
      patch.name !== undefined
        ? normalizeProfileName(patch.name)
        : decoded.name,
    anthropicBaseUrl:
      patch.anthropicBaseUrl !== undefined
        ? normalizeBaseUrl(patch.anthropicBaseUrl)
        : decoded.anthropicBaseUrl,
    anthropicModel:
      patch.anthropicModel !== undefined
        ? normalizeModel(patch.anthropicModel)
        : decoded.anthropicModel,
    customEnv:
      patch.customEnv !== undefined
        ? sanitizeCustomEnvMap(patch.customEnv, {
            skipReservedClaudeKeys: true,
          })
        : decoded.customEnv,
    updatedAt: new Date().toISOString(),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: next.anthropicBaseUrl,
      anthropicAuthToken: next.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: next.anthropicModel,
    },
    next.updatedAt,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    profiles: state.profiles.map((item) =>
      item.id === id ? toStoredProfile(next) : item,
    ),
  });

  return next;
}

export function updateClaudeThirdPartyProfileSecret(
  profileId: string,
  patch: {
    anthropicAuthToken?: string;
    clearAnthropicAuthToken?: boolean;
  },
): ClaudeThirdPartyProfile {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const current = state.profiles.find((item) => item.id === id);
  if (!current) throw new Error('未找到指定第三方配置');

  const decoded = fromStoredProfile(current);
  const nextToken =
    typeof patch.anthropicAuthToken === 'string'
      ? normalizeSecret(patch.anthropicAuthToken, 'anthropicAuthToken')
      : patch.clearAnthropicAuthToken
        ? ''
        : decoded.anthropicAuthToken;

  const next: ClaudeThirdPartyProfile = {
    ...decoded,
    anthropicAuthToken: nextToken,
    updatedAt: new Date().toISOString(),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: next.anthropicBaseUrl,
      anthropicAuthToken: next.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: next.anthropicModel,
    },
    next.updatedAt,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    profiles: state.profiles.map((item) =>
      item.id === id ? toStoredProfile(next) : item,
    ),
  });

  return next;
}

export function activateClaudeThirdPartyProfile(
  profileId: string,
): ClaudeProviderConfig {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const target = state.profiles.find((item) => item.id === id);
  if (!target) throw new Error('未找到指定第三方配置');

  writeStoredState({
    ...state,
    activeProfileId: id,
  });

  return getClaudeProviderConfig();
}

export function deleteClaudeThirdPartyProfile(profileId: string): {
  activeProfileId: string;
  deletedProfileId: string;
} {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  if (!state.profiles.some((item) => item.id === id)) {
    throw new Error('未找到指定第三方配置');
  }
  if (state.profiles.length <= 1) {
    throw new Error('至少需要保留一个第三方配置');
  }

  const profiles = state.profiles.filter((item) => item.id !== id);
  const activeProfileId =
    state.activeProfileId === id ? profiles[0].id : state.activeProfileId;

  writeStoredState({
    ...state,
    activeProfileId,
    profiles,
  });

  return {
    activeProfileId,
    deletedProfileId: id,
  };
}

export function shellQuoteEnvLines(lines: string[]): string[] {
  return lines.map((line) => {
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    const quoted = "'" + value.replace(/'/g, "'\\''") + "'";
    return `${key}=${quoted}`;
  });
}

export function buildClaudeEnvLines(
  config: ClaudeProviderConfig,
  profileCustomEnv?: Record<string, string>,
): string[] {
  const lines: string[] = [];

  if (!config.claudeOAuthCredentials && config.claudeCodeOauthToken) {
    lines.push(
      `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeCodeOauthToken.replace(/[\r\n\0]/g, '')}`,
    );
  }
  if (config.anthropicApiKey) {
    lines.push(
      `ANTHROPIC_API_KEY=${config.anthropicApiKey.replace(/[\r\n\0]/g, '')}`,
    );
  }
  if (config.anthropicBaseUrl) {
    lines.push(
      `ANTHROPIC_BASE_URL=${config.anthropicBaseUrl.replace(/[\r\n\0]/g, '')}`,
    );
  }
  if (config.anthropicAuthToken) {
    lines.push(
      `ANTHROPIC_AUTH_TOKEN=${config.anthropicAuthToken.replace(/[\r\n\0]/g, '')}`,
    );
  }
  if (config.anthropicModel) {
    lines.push(
      `ANTHROPIC_MODEL=${config.anthropicModel.replace(/[\r\n\0]/g, '')}`,
    );
  }

  const customEnv = profileCustomEnv ?? getActiveProfileCustomEnv();
  for (const [key, value] of Object.entries(customEnv)) {
    lines.push(`${key}=${value.replace(/[\r\n\0]/g, '')}`);
  }

  return lines;
}

export function getActiveProfileCustomEnv(): Record<string, string> {
  const state = readStoredStateV4();
  if (!state) return {};

  const enabled = state.providers.find((p) => p.enabled) || state.providers[0];
  if (!enabled) return {};

  return sanitizeCustomEnvMap(enabled.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
}

export function resolveProfileToConfig(
  profileId: string,
): ClaudeProviderConfig {
  const state = readStoredState();
  if (!state) return defaultsFromEnv();

  if (isOfficialClaudeMode(profileId)) {
    return buildOfficialClaudeProviderConfig(
      state.officialSecrets,
      state.officialUpdatedAt,
    );
  }

  const stored = state.profiles.find((p) => p.id === profileId);
  if (!stored) {
    logger.warn(
      { profileId },
      'resolveProfileToConfig: profile not found, falling back to active',
    );
    return getClaudeProviderConfig();
  }

  const profile = fromStoredProfile(stored);
  return buildConfig(
    {
      anthropicBaseUrl: profile.anthropicBaseUrl,
      anthropicAuthToken: profile.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: profile.anthropicModel,
    },
    profile.updatedAt || state.officialUpdatedAt,
  );
}

export function getCustomEnvForProfile(
  profileId: string,
): Record<string, string> {
  const state = readStoredState();
  if (!state) return {};

  if (isOfficialClaudeMode(profileId)) {
    return sanitizeCustomEnvMap(state.officialCustomEnv || {}, {
      skipReservedClaudeKeys: true,
    });
  }

  const exact = state.profiles.find((p) => p.id === profileId);
  if (!exact) {
    logger.warn(
      { profileId },
      'getCustomEnvForProfile: profile not found, falling back to active',
    );
  }
  const profile = exact || state.profiles[0];
  if (!profile) return {};

  const resolved = fromStoredProfile(profile);
  return sanitizeCustomEnvMap(resolved.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
}

export function resolveProfileFull(profileId: string): {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
} {
  return resolveProviderById(profileId);
}

export function saveOfficialCustomEnv(
  customEnv: Record<string, string>,
): Record<string, string> {
  const sanitized = sanitizeCustomEnvMap(customEnv, {
    skipReservedClaudeKeys: true,
  });
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');
  writeStoredState({
    ...state,
    officialCustomEnv: sanitized,
  });
  return sanitized;
}

export function appendClaudeConfigAudit(
  actor: string,
  action: string,
  changedFields: string[],
  metadata?: Record<string, unknown>,
): void {
  const entry: ClaudeConfigAuditEntry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    changedFields,
    metadata,
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  fs.appendFileSync(
    CLAUDE_CONFIG_AUDIT_FILE,
    `${JSON.stringify(entry)}\n`,
    'utf-8',
  );
}

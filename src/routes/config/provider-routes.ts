import { createHash, randomBytes } from 'node:crypto';

import {
  authMiddleware,
  systemConfigMiddleware,
} from '../../middleware/auth.js';
import { logger } from '../../logger.js';
import { providerPool } from '../../provider-pool.js';
import {
  BalancingConfigSchema,
  ClaudeCustomEnvSchema,
  CodexConfigSchema,
  CodexSecretsSchema,
  UnifiedProviderCreateSchema,
  UnifiedProviderPatchSchema,
  UnifiedProviderSecretsSchema,
} from '../../schemas.js';
import {
  appendClaudeConfigAudit,
  createProvider,
  deleteProvider,
  getBalancingConfig,
  getClaudeProviderConfig,
  getCodexProviderConfigWithSource,
  getEnabledProviders,
  getProviders,
  providerToConfig,
  saveBalancingConfig,
  saveCodexProviderConfig,
  saveCodexProviderSecrets,
  toPublicClaudeProviderConfig,
  toPublicCodexProviderConfig,
  toPublicProvider,
  toggleProvider,
  updateAllSessionCredentials,
  updateProvider,
  updateProviderSecrets,
} from '../../runtime-config.js';
import type { ClaudeOAuthCredentials } from '../../runtime-config.js';
import type { AuthUser } from '../../types.js';
import {
  applyClaudeConfigToAllGroups,
  getConfigDeps,
  type ClaudeApplyResultPayload,
  type ConfigRoutesApp,
} from './shared.js';

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const OAUTH_FLOW_TTL = 10 * 60 * 1000;

interface OAuthFlow {
  codeVerifier: string;
  expiresAt: number;
  targetProviderId?: string;
}

const oauthFlows = new Map<string, OAuthFlow>();

setInterval(() => {
  const now = Date.now();
  for (const [key, flow] of oauthFlows) {
    if (flow.expiresAt < now) oauthFlows.delete(key);
  }
}, 60_000);

export function registerProviderRoutes(configRoutes: ConfigRoutesApp): void {
  configRoutes.get('/claude', authMiddleware, systemConfigMiddleware, (c) => {
    try {
      return c.json(toPublicClaudeProviderConfig(getClaudeProviderConfig()));
    } catch (err) {
      logger.error({ err }, 'Failed to load Claude config');
      return c.json({ error: 'Failed to load Claude config' }, 500);
    }
  });

  configRoutes.get('/codex', authMiddleware, systemConfigMiddleware, (c) => {
    try {
      const { config, source } = getCodexProviderConfigWithSource();
      return c.json(toPublicCodexProviderConfig(config, source));
    } catch (err) {
      logger.error({ err }, 'Failed to load Codex config');
      return c.json({ error: 'Failed to load Codex config' }, 500);
    }
  });

  configRoutes.put(
    '/codex',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = CodexConfigSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      try {
        const patch: { openaiBaseUrl?: string; openaiModel?: string } = {};
        if (
          Object.prototype.hasOwnProperty.call(validation.data, 'openaiBaseUrl')
        ) {
          patch.openaiBaseUrl = validation.data.openaiBaseUrl;
        }
        if (
          Object.prototype.hasOwnProperty.call(validation.data, 'openaiModel')
        ) {
          patch.openaiModel = validation.data.openaiModel;
        }

        saveCodexProviderConfig(patch);
        const { config, source } = getCodexProviderConfigWithSource();
        return c.json(toPublicCodexProviderConfig(config, source));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to save Codex config';
        logger.warn({ err }, 'Failed to save Codex config');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.put(
    '/codex/secrets',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = CodexSecretsSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      try {
        saveCodexProviderSecrets(validation.data);
        const { config, source } = getCodexProviderConfigWithSource();
        return c.json(toPublicCodexProviderConfig(config, source));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to save Codex secrets';
        logger.warn({ err }, 'Failed to save Codex secrets');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.get(
    '/claude/providers',
    authMiddleware,
    systemConfigMiddleware,
    (c) => {
      try {
        const providers = getProviders();
        const balancing = getBalancingConfig();
        const enabledProviders = getEnabledProviders();

        providerPool.refreshFromConfig(enabledProviders, balancing);
        const healthStatuses = providerPool.getHealthStatuses();

        return c.json({
          providers: providers.map((p) => ({
            ...toPublicProvider(p),
            health: healthStatuses.find((h) => h.profileId === p.id) || null,
          })),
          balancing,
          enabledCount: enabledProviders.length,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to list providers');
        return c.json({ error: 'Failed to list providers' }, 500);
      }
    },
  );

  configRoutes.post(
    '/claude/providers',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = UnifiedProviderCreateSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      const actor = (c.get('user') as AuthUser).username;

      try {
        const provider = createProvider(validation.data);
        appendClaudeConfigAudit(actor, 'create_provider', [
          `id:${provider.id}`,
          `type:${provider.type}`,
          `name:${provider.name}`,
        ]);
        return c.json(toPublicProvider(provider), 201);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to create provider';
        logger.warn({ err }, 'Failed to create provider');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.patch(
    '/claude/providers/:id',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const { id } = c.req.param();
      const body = await c.req.json().catch(() => ({}));
      const validation = UnifiedProviderPatchSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      const actor = (c.get('user') as AuthUser).username;

      try {
        const updated = updateProvider(id, validation.data);
        const changedFields = Object.keys(validation.data).map(
          (k) => `${k}:updated`,
        );
        appendClaudeConfigAudit(actor, 'update_provider', [
          `id:${id}`,
          ...changedFields,
        ]);

        let applied: ClaudeApplyResultPayload | null = null;
        if (updated.enabled) {
          applied = await applyClaudeConfigToAllGroups(actor, {
            trigger: 'provider_update',
            providerId: id,
          });
        }

        return c.json({
          provider: toPublicProvider(updated),
          ...(applied ? { applied } : {}),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update provider';
        logger.warn({ err }, 'Failed to update provider');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.put(
    '/claude/providers/:id/secrets',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const { id } = c.req.param();
      const body = await c.req.json().catch(() => ({}));
      const validation = UnifiedProviderSecretsSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      const actor = (c.get('user') as AuthUser).username;

      try {
        const updated = updateProviderSecrets(id, validation.data);

        const changedFields: string[] = [];
        if (validation.data.anthropicAuthToken !== undefined) {
          changedFields.push('anthropicAuthToken:set');
        }
        if (validation.data.clearAnthropicAuthToken) {
          changedFields.push('anthropicAuthToken:clear');
        }
        if (validation.data.anthropicApiKey !== undefined) {
          changedFields.push('anthropicApiKey:set');
        }
        if (validation.data.clearAnthropicApiKey) {
          changedFields.push('anthropicApiKey:clear');
        }
        if (validation.data.claudeCodeOauthToken !== undefined) {
          changedFields.push('claudeCodeOauthToken:set');
        }
        if (validation.data.clearClaudeCodeOauthToken) {
          changedFields.push('claudeCodeOauthToken:clear');
        }
        if (validation.data.claudeOAuthCredentials) {
          changedFields.push('claudeOAuthCredentials:set');
        }
        if (validation.data.clearClaudeOAuthCredentials) {
          changedFields.push('claudeOAuthCredentials:clear');
        }

        appendClaudeConfigAudit(actor, 'update_provider_secrets', [
          `id:${id}`,
          ...changedFields,
        ]);

        if (validation.data.claudeOAuthCredentials && updated.enabled) {
          updateAllSessionCredentials(providerToConfig(updated));
          getConfigDeps()?.queue?.closeAllActiveForCredentialRefresh();
        }

        let applied: ClaudeApplyResultPayload | null = null;
        if (updated.enabled) {
          applied = await applyClaudeConfigToAllGroups(actor, {
            trigger: 'provider_secrets_update',
            providerId: id,
          });
        }

        return c.json({
          provider: toPublicProvider(updated),
          ...(applied ? { applied } : {}),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update secrets';
        logger.warn({ err }, 'Failed to update provider secrets');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.delete(
    '/claude/providers/:id',
    authMiddleware,
    systemConfigMiddleware,
    (c) => {
      const { id } = c.req.param();
      const actor = (c.get('user') as AuthUser).username;

      try {
        deleteProvider(id);
        appendClaudeConfigAudit(actor, 'delete_provider', [`id:${id}`]);
        return c.json({ ok: true });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to delete provider';
        logger.warn({ err }, 'Failed to delete provider');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.post(
    '/claude/providers/:id/toggle',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const { id } = c.req.param();
      const actor = (c.get('user') as AuthUser).username;

      try {
        const updated = toggleProvider(id);
        appendClaudeConfigAudit(actor, 'toggle_provider', [
          `id:${id}`,
          `enabled:${updated.enabled}`,
        ]);

        const applied = await applyClaudeConfigToAllGroups(actor, {
          trigger: 'provider_toggle',
          providerId: id,
        });

        return c.json({
          provider: toPublicProvider(updated),
          applied,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to toggle provider';
        logger.warn({ err }, 'Failed to toggle provider');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.post(
    '/claude/providers/:id/reset-health',
    authMiddleware,
    systemConfigMiddleware,
    (c) => {
      const { id } = c.req.param();
      providerPool.resetHealth(id);
      return c.json({ ok: true });
    },
  );

  configRoutes.get(
    '/claude/providers/health',
    authMiddleware,
    systemConfigMiddleware,
    (c) => {
      const enabledProviders = getEnabledProviders();
      const balancing = getBalancingConfig();
      providerPool.refreshFromConfig(enabledProviders, balancing);
      return c.json({ statuses: providerPool.getHealthStatuses() });
    },
  );

  configRoutes.put(
    '/claude/balancing',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = BalancingConfigSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      const actor = (c.get('user') as AuthUser).username;

      try {
        const saved = saveBalancingConfig(validation.data);
        appendClaudeConfigAudit(actor, 'update_balancing', [
          ...Object.keys(validation.data),
        ]);
        return c.json(saved);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update balancing';
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.post(
    '/claude/apply',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const actor = (c.get('user') as AuthUser).username;
      try {
        const result = await applyClaudeConfigToAllGroups(actor);
        if (!result.success) {
          return c.json(result, 207);
        }
        return c.json(result);
      } catch (err) {
        logger.error({ err }, 'Failed to apply Claude config to all groups');
        return c.json({ error: 'Server not initialized' }, 500);
      }
    },
  );

  configRoutes.post(
    '/claude/oauth/start',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const targetProviderId =
        typeof (body as Record<string, unknown>).targetProviderId === 'string'
          ? ((body as Record<string, unknown>).targetProviderId as string)
          : undefined;

      const state = randomBytes(32).toString('hex');
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      oauthFlows.set(state, {
        codeVerifier,
        expiresAt: Date.now() + OAUTH_FLOW_TTL,
        targetProviderId,
      });

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      return c.json({
        authorizeUrl: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`,
        state,
      });
    },
  );

  configRoutes.post(
    '/claude/oauth/callback',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const { state, code } = body as { state?: string; code?: string };

      if (!state || !code) {
        return c.json({ error: 'Missing state or code' }, 400);
      }

      const cleanedCode =
        code.trim().split('#')[0]?.split('&')[0] ?? code.trim();

      const flow = oauthFlows.get(state);
      if (!flow) {
        return c.json({ error: 'Invalid or expired OAuth state' }, 400);
      }
      if (flow.expiresAt < Date.now()) {
        oauthFlows.delete(state);
        return c.json({ error: 'OAuth flow expired' }, 400);
      }
      oauthFlows.delete(state);

      try {
        const tokenResp = await fetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://claude.ai/',
            Origin: 'https://claude.ai',
          },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: OAUTH_CLIENT_ID,
            code: cleanedCode,
            redirect_uri: OAUTH_REDIRECT_URI,
            code_verifier: flow.codeVerifier,
            state,
            expires_in: 31536000,
          }),
        });

        if (!tokenResp.ok) {
          const errText = await tokenResp.text().catch(() => '');
          logger.warn(
            { status: tokenResp.status, body: errText },
            'OAuth token exchange failed',
          );
          return c.json(
            { error: `Token exchange failed: ${tokenResp.status}` },
            400,
          );
        }

        const tokenData = (await tokenResp.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
          [key: string]: unknown;
        };

        if (!tokenData.access_token) {
          return c.json({ error: 'No access_token in response' }, 400);
        }

        const actor = (c.get('user') as AuthUser).username;

        let oauthCredentials: ClaudeOAuthCredentials | null = null;
        if (tokenData.refresh_token) {
          const expiresAt = tokenData.expires_in
            ? Date.now() + tokenData.expires_in * 1000
            : Date.now() + 8 * 60 * 60 * 1000;
          oauthCredentials = {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt,
            scopes: tokenData.scope ? tokenData.scope.split(' ') : [],
          };
        }

        let provider;
        if (flow.targetProviderId) {
          provider = updateProviderSecrets(flow.targetProviderId, {
            claudeOAuthCredentials: oauthCredentials ?? undefined,
            claudeCodeOauthToken: oauthCredentials
              ? undefined
              : tokenData.access_token,
            clearAnthropicApiKey: true,
          });
        } else {
          provider = createProvider({
            name: '官方 Claude (OAuth)',
            type: 'official',
            claudeOAuthCredentials: oauthCredentials,
            claudeCodeOauthToken: oauthCredentials
              ? ''
              : tokenData.access_token,
            enabled: true,
          });
        }

        if (oauthCredentials) {
          updateAllSessionCredentials(providerToConfig(provider));
          getConfigDeps()?.queue?.closeAllActiveForCredentialRefresh();
        }

        appendClaudeConfigAudit(actor, 'oauth_login', [
          `providerId:${provider.id}`,
          oauthCredentials
            ? 'claudeOAuthCredentials:set'
            : 'claudeCodeOauthToken:set',
        ]);

        return c.json(toPublicProvider(provider));
      } catch (err) {
        logger.error({ err }, 'OAuth token exchange error');
        const message =
          err instanceof Error ? err.message : 'OAuth token exchange failed';
        return c.json({ error: message }, 500);
      }
    },
  );

  configRoutes.put(
    '/claude/custom-env',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = ClaudeCustomEnvSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      try {
        const enabled = getEnabledProviders();
        if (enabled.length === 0) {
          return c.json({ error: '没有启用的供应商' }, 400);
        }

        const updated = updateProvider(enabled[0].id, {
          customEnv: validation.data.customEnv,
        });
        return c.json({ customEnv: updated.customEnv });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Invalid custom env payload';
        logger.warn({ err }, 'Invalid Claude custom env payload');
        return c.json({ error: message }, 400);
      }
    },
  );
}

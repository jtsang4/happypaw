import {
  authMiddleware,
  systemConfigMiddleware,
} from '../../middleware/auth.js';
import { logger } from '../../logger.js';
import { CodexConfigSchema, CodexSecretsSchema } from '../../schemas.js';
import {
  getCodexProviderConfigWithSource,
  saveCodexProviderConfig,
  saveCodexProviderSecrets,
  toPublicCodexProviderConfig,
} from '../../runtime-config.js';
import type { ConfigRoutesApp } from './shared.js';

export function registerCodexRoutes(configRoutes: ConfigRoutesApp): void {
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
}

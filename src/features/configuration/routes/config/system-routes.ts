import {
  authMiddleware,
  systemConfigMiddleware,
} from '../../../../middleware/auth.js';
import { logger } from '../../../../app/logger.js';
import {
  AppearanceConfigSchema,
  FeishuConfigSchema,
  RegistrationConfigSchema,
  SystemSettingsSchema,
  TelegramConfigSchema,
} from '../../../../app/web/schemas.js';
import {
  getAppearanceConfig,
  getFeishuProviderConfig,
  getFeishuProviderConfigWithSource,
  getRegistrationConfig,
  getSystemSettings,
  getTelegramProviderConfig,
  getTelegramProviderConfigWithSource,
  saveAppearanceConfig,
  saveFeishuProviderConfig,
  saveRegistrationConfig,
  saveSystemSettings,
  saveTelegramProviderConfig,
  toPublicFeishuProviderConfig,
  toPublicTelegramProviderConfig,
} from '../../../../runtime-config.js';
import { clearBillingEnabledCache } from '../../../billing/billing.js';
import {
  createTelegramApiAgent,
  destroyTelegramApiAgent,
  getConfigDeps,
  type ConfigRoutesApp,
} from './shared.js';

function toPublicSystemSettings() {
  const { defaultRuntime: _defaultRuntime, ...rest } = getSystemSettings();
  return rest;
}

export function registerSystemRoutes(configRoutes: ConfigRoutesApp): void {
  configRoutes.get('/feishu', authMiddleware, systemConfigMiddleware, (c) => {
    try {
      const { config, source } = getFeishuProviderConfigWithSource();
      const pub = toPublicFeishuProviderConfig(config, source);
      const connected = getConfigDeps()?.isFeishuConnected?.() ?? false;
      return c.json({ ...pub, connected });
    } catch (err) {
      logger.error({ err }, 'Failed to load Feishu config');
      return c.json({ error: 'Failed to load Feishu config' }, 500);
    }
  });

  configRoutes.put(
    '/feishu',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = FeishuConfigSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      const current = getFeishuProviderConfig();
      const next = { ...current };
      if (typeof validation.data.appId === 'string') {
        next.appId = validation.data.appId;
      }
      if (typeof validation.data.appSecret === 'string') {
        next.appSecret = validation.data.appSecret;
      } else if (validation.data.clearAppSecret === true) {
        next.appSecret = '';
      }
      if (typeof validation.data.enabled === 'boolean') {
        next.enabled = validation.data.enabled;
      }

      try {
        const saved = saveFeishuProviderConfig({
          appId: next.appId,
          appSecret: next.appSecret,
          enabled: next.enabled,
        });

        let connected = false;
        const deps = getConfigDeps();
        if (deps?.reloadFeishuConnection) {
          try {
            connected = await deps.reloadFeishuConnection(saved);
          } catch (err: unknown) {
            logger.warn({ err }, 'Failed to reload Feishu connection');
          }
        }

        return c.json({
          ...toPublicFeishuProviderConfig(saved, 'runtime'),
          connected,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Invalid Feishu config payload';
        logger.warn({ err }, 'Invalid Feishu config payload');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.get('/telegram', authMiddleware, systemConfigMiddleware, (c) => {
    try {
      const { config, source } = getTelegramProviderConfigWithSource();
      const pub = toPublicTelegramProviderConfig(config, source);
      const connected = getConfigDeps()?.isTelegramConnected?.() ?? false;
      return c.json({ ...pub, connected });
    } catch (err) {
      logger.error({ err }, 'Failed to load Telegram config');
      return c.json({ error: 'Failed to load Telegram config' }, 500);
    }
  });

  configRoutes.put(
    '/telegram',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = TelegramConfigSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      const current = getTelegramProviderConfig();
      const next = { ...current };
      if (typeof validation.data.botToken === 'string') {
        next.botToken = validation.data.botToken;
      } else if (validation.data.clearBotToken === true) {
        next.botToken = '';
      }
      if (typeof validation.data.proxyUrl === 'string') {
        next.proxyUrl = validation.data.proxyUrl;
      } else if (validation.data.clearProxyUrl === true) {
        next.proxyUrl = '';
      }
      if (typeof validation.data.enabled === 'boolean') {
        next.enabled = validation.data.enabled;
      }

      try {
        const saved = saveTelegramProviderConfig({
          botToken: next.botToken,
          proxyUrl: next.proxyUrl,
          enabled: next.enabled,
        });

        let connected = false;
        const deps = getConfigDeps();
        if (deps?.reloadTelegramConnection) {
          try {
            connected = await deps.reloadTelegramConnection(saved);
          } catch (err: unknown) {
            logger.warn({ err }, 'Failed to reload Telegram connection');
          }
        }

        return c.json({
          ...toPublicTelegramProviderConfig(saved, 'runtime'),
          connected,
        });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Invalid Telegram config payload';
        logger.warn({ err }, 'Invalid Telegram config payload');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.post(
    '/telegram/test',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const config = getTelegramProviderConfig();
      if (!config.botToken) {
        return c.json({ error: 'Telegram bot token not configured' }, 400);
      }

      const agent = createTelegramApiAgent(config.proxyUrl);
      try {
        const { Bot } = await import('grammy');
        const testBot = new Bot(config.botToken, {
          client: {
            timeoutSeconds: 15,
            baseFetchConfig: {
              agent,
            },
          },
        });

        let me: { username?: string; id: number; first_name: string } | null =
          null;
        let lastErr: unknown = null;
        for (let i = 0; i < 3; i++) {
          try {
            me = await testBot.api.getMe();
            break;
          } catch (err) {
            lastErr = err;
            if (i < 2) {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }
        }
        if (!me) {
          throw lastErr instanceof Error
            ? lastErr
            : new Error('Telegram API request failed');
        }

        return c.json({
          success: true,
          bot_username: me.username,
          bot_id: me.id,
          bot_name: me.first_name,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to connect to Telegram';
        logger.warn({ err }, 'Failed to test Telegram connection');
        return c.json({ error: message }, 400);
      } finally {
        destroyTelegramApiAgent(agent);
      }
    },
  );

  configRoutes.get(
    '/registration',
    authMiddleware,
    systemConfigMiddleware,
    (c) => {
      try {
        return c.json(getRegistrationConfig());
      } catch (err) {
        logger.error({ err }, 'Failed to load registration config');
        return c.json({ error: 'Failed to load registration config' }, 500);
      }
    },
  );

  configRoutes.put(
    '/registration',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = RegistrationConfigSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      try {
        const saved = saveRegistrationConfig(validation.data);
        return c.json(saved);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Invalid registration config payload';
        logger.warn({ err }, 'Invalid registration config payload');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.get(
    '/appearance',
    authMiddleware,
    systemConfigMiddleware,
    (c) => {
      try {
        return c.json(getAppearanceConfig());
      } catch (err) {
        logger.error({ err }, 'Failed to load appearance config');
        return c.json({ error: 'Failed to load appearance config' }, 500);
      }
    },
  );

  configRoutes.put(
    '/appearance',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = AppearanceConfigSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      try {
        const saved = saveAppearanceConfig(validation.data);
        return c.json(saved);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Invalid appearance config payload';
        logger.warn({ err }, 'Invalid appearance config payload');
        return c.json({ error: message }, 400);
      }
    },
  );

  configRoutes.get('/appearance/public', (c) => {
    try {
      const config = getAppearanceConfig();
      return c.json({
        appName: config.appName,
        aiName: config.aiName,
        aiAvatarEmoji: config.aiAvatarEmoji,
        aiAvatarColor: config.aiAvatarColor,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to load public appearance config');
      return c.json({ error: 'Failed to load appearance config' }, 500);
    }
  });

  configRoutes.get('/system', authMiddleware, systemConfigMiddleware, (c) => {
    try {
      return c.json(toPublicSystemSettings());
    } catch (err) {
      logger.error({ err }, 'Failed to load system settings');
      return c.json({ error: 'Failed to load system settings' }, 500);
    }
  });

  configRoutes.put(
    '/system',
    authMiddleware,
    systemConfigMiddleware,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const validation = SystemSettingsSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Invalid request body', details: validation.error.format() },
          400,
        );
      }

      try {
        const saved = saveSystemSettings(validation.data);
        clearBillingEnabledCache();
        const { defaultRuntime: _defaultRuntime, ...publicSettings } = saved;
        return c.json(publicSettings);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Invalid system settings payload';
        logger.warn({ err }, 'Invalid system settings payload');
        return c.json({ error: message }, 400);
      }
    },
  );
}

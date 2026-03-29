import { authMiddleware } from '../../../../middleware/auth.js';
import { logger } from '../../../../app/logger.js';
import {
  FeishuConfigSchema,
  QQConfigSchema,
  TelegramConfigSchema,
} from '../../../../app/web/schemas.js';
import {
  getTelegramProviderConfig,
  getUserFeishuConfig,
  getUserQQConfig,
  getUserTelegramConfig,
  saveUserFeishuConfig,
  saveUserQQConfig,
  saveUserTelegramConfig,
  toPublicFeishuProviderConfig,
  toPublicTelegramProviderConfig,
} from '../../../../runtime-config.js';
import type { AuthUser } from '../../../../shared/types.js';
import {
  checkImChannelLimit,
  isBillingEnabled,
} from '../../../billing/billing.js';
import { deleteChatHistory, deleteRegisteredGroup } from '../../../../db.js';
import {
  countOtherEnabledImChannels,
  createTelegramApiAgent,
  destroyTelegramApiAgent,
  getConfigDeps,
  maskQQAppSecret,
  resolveProxyInfo,
  type ConfigRoutesApp,
} from './shared.js';

export function registerUserImRoutes(configRoutes: ConfigRoutesApp): void {
  configRoutes.get('/user-im/status', authMiddleware, (c) => {
    const user = c.get('user') as AuthUser;
    const deps = getConfigDeps();
    return c.json({
      feishu: deps?.isUserFeishuConnected?.(user.id) ?? false,
      telegram: deps?.isUserTelegramConnected?.(user.id) ?? false,
      qq: deps?.isUserQQConnected?.(user.id) ?? false,
      wechat: deps?.isUserWeChatConnected?.(user.id) ?? false,
    });
  });

  configRoutes.get('/user-im/feishu', authMiddleware, (c) => {
    const user = c.get('user') as AuthUser;
    try {
      const config = getUserFeishuConfig(user.id);
      const connected =
        getConfigDeps()?.isUserFeishuConnected?.(user.id) ?? false;
      if (!config) {
        return c.json({
          appId: '',
          hasAppSecret: false,
          appSecretMasked: null,
          enabled: false,
          updatedAt: null,
          connected,
        });
      }
      return c.json({
        ...toPublicFeishuProviderConfig(config, 'runtime'),
        connected,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to load user Feishu config');
      return c.json({ error: 'Failed to load user Feishu config' }, 500);
    }
  });

  configRoutes.put('/user-im/feishu', authMiddleware, async (c) => {
    const user = c.get('user') as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    const validation = FeishuConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    if (validation.data.enabled === true && isBillingEnabled()) {
      const currentFeishu = getUserFeishuConfig(user.id);
      if (!currentFeishu?.enabled) {
        const limit = checkImChannelLimit(
          user.id,
          user.role,
          countOtherEnabledImChannels(user.id, 'feishu'),
        );
        if (!limit.allowed) {
          return c.json({ error: limit.reason }, 403);
        }
      }
    }

    const current = getUserFeishuConfig(user.id);
    const next = {
      appId: current?.appId || '',
      appSecret: current?.appSecret || '',
      enabled: current?.enabled ?? true,
      updatedAt: current?.updatedAt || null,
    };
    if (typeof validation.data.appId === 'string') {
      const appId = validation.data.appId.trim();
      if (appId) next.appId = appId;
    }
    if (typeof validation.data.appSecret === 'string') {
      const appSecret = validation.data.appSecret.trim();
      if (appSecret) next.appSecret = appSecret;
    } else if (validation.data.clearAppSecret === true) {
      next.appSecret = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    } else if (!current && (next.appId || next.appSecret)) {
      next.enabled = true;
    }

    try {
      const saved = saveUserFeishuConfig(user.id, {
        appId: next.appId,
        appSecret: next.appSecret,
        enabled: next.enabled,
      });

      const deps = getConfigDeps();
      if (deps?.reloadUserIMConfig) {
        try {
          await deps.reloadUserIMConfig(user.id, 'feishu');
        } catch (err) {
          logger.warn(
            { err, userId: user.id },
            'Failed to hot-reload user Feishu connection',
          );
        }
      }

      const connected = deps?.isUserFeishuConnected?.(user.id) ?? false;
      return c.json({
        ...toPublicFeishuProviderConfig(saved, 'runtime'),
        connected,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Feishu config payload';
      logger.warn({ err }, 'Invalid user Feishu config payload');
      return c.json({ error: message }, 400);
    }
  });

  configRoutes.get('/user-im/telegram', authMiddleware, (c) => {
    const user = c.get('user') as AuthUser;
    try {
      const config = getUserTelegramConfig(user.id);
      const connected =
        getConfigDeps()?.isUserTelegramConnected?.(user.id) ?? false;
      const globalConfig = getTelegramProviderConfig();
      const userProxy = config?.proxyUrl || '';
      const sysProxy = globalConfig.proxyUrl || '';
      const proxy = resolveProxyInfo(userProxy, sysProxy);
      if (!config) {
        return c.json({
          hasBotToken: false,
          botTokenMasked: null,
          enabled: false,
          updatedAt: null,
          connected,
          proxyUrl: '',
          ...proxy,
        });
      }
      return c.json({
        ...toPublicTelegramProviderConfig(config, 'runtime'),
        connected,
        proxyUrl: userProxy,
        ...proxy,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to load user Telegram config');
      return c.json({ error: 'Failed to load user Telegram config' }, 500);
    }
  });

  configRoutes.put('/user-im/telegram', authMiddleware, async (c) => {
    const user = c.get('user') as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    const validation = TelegramConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    if (validation.data.enabled === true && isBillingEnabled()) {
      const currentTg = getUserTelegramConfig(user.id);
      if (!currentTg?.enabled) {
        const limit = checkImChannelLimit(
          user.id,
          user.role,
          countOtherEnabledImChannels(user.id, 'telegram'),
        );
        if (!limit.allowed) {
          return c.json({ error: limit.reason }, 403);
        }
      }
    }

    const current = getUserTelegramConfig(user.id);
    const next = {
      botToken: current?.botToken || '',
      proxyUrl: current?.proxyUrl || '',
      enabled: current?.enabled ?? true,
      updatedAt: current?.updatedAt || null,
    };
    if (typeof validation.data.botToken === 'string') {
      const botToken = validation.data.botToken.trim();
      if (botToken) next.botToken = botToken;
    } else if (validation.data.clearBotToken === true) {
      next.botToken = '';
    }
    if (typeof validation.data.proxyUrl === 'string') {
      next.proxyUrl = validation.data.proxyUrl.trim();
    } else if (validation.data.clearProxyUrl === true) {
      next.proxyUrl = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    } else if (!current && next.botToken) {
      next.enabled = true;
    }

    try {
      const saved = saveUserTelegramConfig(user.id, {
        botToken: next.botToken,
        proxyUrl: next.proxyUrl || undefined,
        enabled: next.enabled,
      });

      const deps = getConfigDeps();
      if (deps?.reloadUserIMConfig) {
        try {
          await deps.reloadUserIMConfig(user.id, 'telegram');
        } catch (err) {
          logger.warn(
            { err, userId: user.id },
            'Failed to hot-reload user Telegram connection',
          );
        }
      }

      const connected = deps?.isUserTelegramConnected?.(user.id) ?? false;
      const userProxy = saved.proxyUrl || '';
      const sysProxy = getTelegramProviderConfig().proxyUrl || '';
      return c.json({
        ...toPublicTelegramProviderConfig(saved, 'runtime'),
        connected,
        proxyUrl: userProxy,
        ...resolveProxyInfo(userProxy, sysProxy),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Telegram config payload';
      logger.warn({ err }, 'Invalid user Telegram config payload');
      return c.json({ error: message }, 400);
    }
  });

  configRoutes.post('/user-im/telegram/test', authMiddleware, async (c) => {
    const user = c.get('user') as AuthUser;
    const config = getUserTelegramConfig(user.id);
    if (!config?.botToken) {
      return c.json({ error: 'Telegram bot token not configured' }, 400);
    }

    const globalTelegramConfig = getTelegramProviderConfig();
    const effectiveProxy = config.proxyUrl || globalTelegramConfig.proxyUrl;
    const agent = createTelegramApiAgent(effectiveProxy);
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
      const me = await testBot.api.getMe();
      return c.json({
        success: true,
        bot_username: me.username,
        bot_id: me.id,
        bot_name: me.first_name,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect to Telegram';
      logger.warn({ err }, 'Failed to test user Telegram connection');
      return c.json({ error: message }, 400);
    } finally {
      destroyTelegramApiAgent(agent);
    }
  });

  configRoutes.post(
    '/user-im/telegram/pairing-code',
    authMiddleware,
    async (c) => {
      const user = c.get('user') as AuthUser;
      const config = getUserTelegramConfig(user.id);
      if (!config?.botToken) {
        return c.json({ error: 'Telegram bot token not configured' }, 400);
      }

      try {
        const { generatePairingCode } =
          await import('../../../im/channels/telegram/pairing.js');
        const result = generatePairingCode(user.id);
        return c.json(result);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Failed to generate pairing code';
        logger.warn({ err }, 'Failed to generate pairing code');
        return c.json({ error: message }, 500);
      }
    },
  );

  configRoutes.get('/user-im/telegram/paired-chats', authMiddleware, (c) => {
    const user = c.get('user') as AuthUser;
    const groups = (getConfigDeps()?.getRegisteredGroups() ?? {}) as Record<
      string,
      { name: string; added_at: string; created_by?: string }
    >;
    const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
    for (const [jid, group] of Object.entries(groups)) {
      if (jid.startsWith('telegram:') && group.created_by === user.id) {
        chats.push({ jid, name: group.name, addedAt: group.added_at });
      }
    }
    return c.json({ chats });
  });

  configRoutes.delete(
    '/user-im/telegram/paired-chats/:jid',
    authMiddleware,
    (c) => {
      const user = c.get('user') as AuthUser;
      const jid = decodeURIComponent(c.req.param('jid'));

      if (!jid.startsWith('telegram:')) {
        return c.json({ error: 'Invalid Telegram chat JID' }, 400);
      }

      const groups = getConfigDeps()?.getRegisteredGroups() ?? {};
      const group = groups[jid];
      if (!group) {
        return c.json({ error: 'Chat not found' }, 404);
      }
      if (group.created_by !== user.id) {
        return c.json({ error: 'Not authorized to remove this chat' }, 403);
      }

      deleteRegisteredGroup(jid);
      deleteChatHistory(jid);
      delete groups[jid];
      logger.info({ jid, userId: user.id }, 'Telegram chat unpaired');
      return c.json({ success: true });
    },
  );

  configRoutes.get('/user-im/qq', authMiddleware, (c) => {
    const user = c.get('user') as AuthUser;
    try {
      const config = getUserQQConfig(user.id);
      const connected = getConfigDeps()?.isUserQQConnected?.(user.id) ?? false;
      if (!config) {
        return c.json({
          appId: '',
          hasAppSecret: false,
          appSecretMasked: null,
          enabled: false,
          updatedAt: null,
          connected,
        });
      }
      return c.json({
        appId: config.appId,
        hasAppSecret: !!config.appSecret,
        appSecretMasked: maskQQAppSecret(config.appSecret),
        enabled: config.enabled ?? false,
        updatedAt: config.updatedAt,
        connected,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to load user QQ config');
      return c.json({ error: 'Failed to load user QQ config' }, 500);
    }
  });

  configRoutes.put('/user-im/qq', authMiddleware, async (c) => {
    const user = c.get('user') as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    const validation = QQConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    if (validation.data.enabled === true && isBillingEnabled()) {
      const currentQQ = getUserQQConfig(user.id);
      if (!currentQQ?.enabled) {
        const limit = checkImChannelLimit(
          user.id,
          user.role,
          countOtherEnabledImChannels(user.id, 'qq'),
        );
        if (!limit.allowed) {
          return c.json({ error: limit.reason }, 403);
        }
      }
    }

    const current = getUserQQConfig(user.id);
    const next = {
      appId: current?.appId || '',
      appSecret: current?.appSecret || '',
      enabled: current?.enabled ?? true,
    };
    if (typeof validation.data.appId === 'string') {
      next.appId = validation.data.appId.trim();
    }
    if (typeof validation.data.appSecret === 'string') {
      const appSecret = validation.data.appSecret.trim();
      if (appSecret) next.appSecret = appSecret;
    } else if (validation.data.clearAppSecret === true) {
      next.appSecret = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    } else if (!current && next.appId && next.appSecret) {
      next.enabled = true;
    }

    try {
      const saved = saveUserQQConfig(user.id, {
        appId: next.appId,
        appSecret: next.appSecret,
        enabled: next.enabled,
      });

      const deps = getConfigDeps();
      if (deps?.reloadUserIMConfig) {
        try {
          await deps.reloadUserIMConfig(user.id, 'qq');
        } catch (err) {
          logger.warn(
            { err, userId: user.id },
            'Failed to hot-reload user QQ connection',
          );
        }
      }

      const connected = deps?.isUserQQConnected?.(user.id) ?? false;
      return c.json({
        appId: saved.appId,
        hasAppSecret: !!saved.appSecret,
        appSecretMasked: maskQQAppSecret(saved.appSecret),
        enabled: saved.enabled ?? false,
        updatedAt: saved.updatedAt,
        connected,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid QQ config payload';
      logger.warn({ err }, 'Invalid user QQ config payload');
      return c.json({ error: message }, 400);
    }
  });

  configRoutes.post('/user-im/qq/test', authMiddleware, async (c) => {
    const user = c.get('user') as AuthUser;
    const config = getUserQQConfig(user.id);
    if (!config?.appId || !config?.appSecret) {
      return c.json({ error: 'QQ App ID and App Secret not configured' }, 400);
    }

    try {
      const https = await import('node:https');
      const body = JSON.stringify({
        appId: config.appId,
        clientSecret: config.appSecret,
      });

      const result = await new Promise<{
        access_token?: string;
        expires_in?: number;
      }>((resolve, reject) => {
        const url = new URL('https://bots.qq.com/app/getAppAccessToken');
        const req = https.request(
          {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(body)),
            },
            timeout: 15000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
              } catch (err) {
                reject(err);
              }
            });
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('Request timeout'));
        });
        req.write(body);
        req.end();
      });

      if (!result.access_token) {
        return c.json(
          {
            error:
              'Failed to obtain access token. Please check App ID and App Secret.',
          },
          400,
        );
      }

      return c.json({
        success: true,
        expires_in: result.expires_in,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect to QQ';
      logger.warn({ err }, 'Failed to test user QQ connection');
      return c.json({ error: message }, 400);
    }
  });

  configRoutes.post('/user-im/qq/pairing-code', authMiddleware, async (c) => {
    const user = c.get('user') as AuthUser;
    const config = getUserQQConfig(user.id);
    if (!config?.appId || !config?.appSecret) {
      return c.json({ error: 'QQ App ID and App Secret not configured' }, 400);
    }

    try {
      const { generatePairingCode } =
        await import('../../../im/channels/telegram/pairing.js');
      const result = generatePairingCode(user.id);
      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate pairing code';
      logger.warn({ err }, 'Failed to generate QQ pairing code');
      return c.json({ error: message }, 500);
    }
  });

  configRoutes.get('/user-im/qq/paired-chats', authMiddleware, (c) => {
    const user = c.get('user') as AuthUser;
    const groups = (getConfigDeps()?.getRegisteredGroups() ?? {}) as Record<
      string,
      { name: string; added_at: string; created_by?: string }
    >;
    const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
    for (const [jid, group] of Object.entries(groups)) {
      if (jid.startsWith('qq:') && group.created_by === user.id) {
        chats.push({ jid, name: group.name, addedAt: group.added_at });
      }
    }
    return c.json({ chats });
  });

  configRoutes.delete('/user-im/qq/paired-chats/:jid', authMiddleware, (c) => {
    const user = c.get('user') as AuthUser;
    const jid = decodeURIComponent(c.req.param('jid'));

    if (!jid.startsWith('qq:')) {
      return c.json({ error: 'Invalid QQ chat JID' }, 400);
    }

    const groups = getConfigDeps()?.getRegisteredGroups() ?? {};
    const group = groups[jid];
    if (!group) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    if (group.created_by !== user.id) {
      return c.json({ error: 'Not authorized to remove this chat' }, 403);
    }

    deleteRegisteredGroup(jid);
    deleteChatHistory(jid);
    delete groups[jid];
    logger.info({ jid, userId: user.id }, 'QQ chat unpaired');
    return c.json({ success: true });
  });
}

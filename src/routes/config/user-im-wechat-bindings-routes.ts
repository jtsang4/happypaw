import QRCode from 'qrcode';

import { getChannelFromJid } from '../../channel-prefixes.js';
import { updateWeChatNoProxy } from '../../config.js';
import {
  deleteChatHistory,
  deleteRegisteredGroup,
  getAgent,
  getRegisteredGroup,
} from '../../db.js';
import { authMiddleware } from '../../middleware/auth.js';
import { logger } from '../../logger.js';
import { WeChatConfigSchema } from '../../schemas.js';
import {
  getUserWeChatConfig,
  saveUserWeChatConfig,
} from '../../runtime-config.js';
import type { AuthUser, RegisteredGroup } from '../../types.js';
import { canAccessGroup } from '../../web-context.js';
import { checkImChannelLimit, isBillingEnabled } from '../../billing.js';
import {
  applyBindingUpdate,
  countOtherEnabledImChannels,
  getConfigDeps,
  maskBotToken,
  type ConfigRoutesApp,
} from './shared.js';

const WECHAT_API_BASE = 'https://ilinkai.weixin.qq.com';
const WECHAT_QR_BOT_TYPE = '3';

export function registerUserImWeChatAndBindingRoutes(
  configRoutes: ConfigRoutesApp,
): void {
  configRoutes.get('/user-im/wechat', authMiddleware, (c) => {
    const user = c.get('user') as AuthUser;
    try {
      const config = getUserWeChatConfig(user.id);
      const connected =
        getConfigDeps()?.isUserWeChatConnected?.(user.id) ?? false;
      if (!config) {
        return c.json({
          ilinkBotId: '',
          hasBotToken: false,
          botTokenMasked: null,
          bypassProxy: true,
          enabled: false,
          updatedAt: null,
          connected,
        });
      }
      return c.json({
        ilinkBotId: config.ilinkBotId || '',
        hasBotToken: !!config.botToken,
        botTokenMasked: maskBotToken(config.botToken),
        bypassProxy: config.bypassProxy ?? true,
        enabled: config.enabled ?? false,
        updatedAt: config.updatedAt,
        connected,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to load user WeChat config');
      return c.json({ error: 'Failed to load user WeChat config' }, 500);
    }
  });

  configRoutes.put('/user-im/wechat', authMiddleware, async (c) => {
    const user = c.get('user') as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    const validation = WeChatConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    if (validation.data.enabled === true && isBillingEnabled()) {
      const currentWc = getUserWeChatConfig(user.id);
      if (!currentWc?.enabled) {
        const limit = checkImChannelLimit(
          user.id,
          user.role,
          countOtherEnabledImChannels(user.id, 'wechat'),
        );
        if (!limit.allowed) {
          return c.json({ error: limit.reason }, 403);
        }
      }
    }

    const current = getUserWeChatConfig(user.id);
    const next = {
      botToken: current?.botToken || '',
      ilinkBotId: current?.ilinkBotId || '',
      baseUrl: current?.baseUrl,
      cdnBaseUrl: current?.cdnBaseUrl,
      getUpdatesBuf: current?.getUpdatesBuf,
      bypassProxy: current?.bypassProxy ?? true,
      enabled: current?.enabled ?? false,
    };

    if (validation.data.clearBotToken === true) {
      next.botToken = '';
      next.ilinkBotId = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    }
    if (typeof validation.data.bypassProxy === 'boolean') {
      next.bypassProxy = validation.data.bypassProxy;
    }

    try {
      const saved = saveUserWeChatConfig(user.id, next);

      updateWeChatNoProxy(saved.bypassProxy ?? true);

      const deps = getConfigDeps();
      if (deps?.reloadUserIMConfig) {
        try {
          await deps.reloadUserIMConfig(user.id, 'wechat');
        } catch (err) {
          logger.warn(
            { err, userId: user.id },
            'Failed to hot-reload user WeChat connection',
          );
        }
      }

      const connected = deps?.isUserWeChatConnected?.(user.id) ?? false;
      return c.json({
        ilinkBotId: saved.ilinkBotId || '',
        hasBotToken: !!saved.botToken,
        botTokenMasked: maskBotToken(saved.botToken),
        bypassProxy: saved.bypassProxy ?? true,
        enabled: saved.enabled ?? false,
        updatedAt: saved.updatedAt,
        connected,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid WeChat config payload';
      logger.warn({ err }, 'Invalid user WeChat config payload');
      return c.json({ error: message }, 400);
    }
  });

  configRoutes.post('/user-im/wechat/qrcode', authMiddleware, async (c) => {
    try {
      const url = `${WECHAT_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_QR_BOT_TYPE)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.error(
          { status: res.status, body },
          'WeChat QR code fetch failed',
        );
        return c.json({ error: `Failed to fetch QR code: ${res.status}` }, 502);
      }
      const data = (await res.json()) as {
        qrcode?: string;
        qrcode_img_content?: string;
      };
      if (!data.qrcode) {
        return c.json({ error: 'No QR code in response' }, 502);
      }

      let qrcodeDataUri = '';
      if (data.qrcode_img_content) {
        try {
          qrcodeDataUri = await QRCode.toDataURL(data.qrcode_img_content, {
            width: 512,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
          });
        } catch (qrErr) {
          logger.warn({ err: qrErr }, 'Failed to generate QR code image');
        }
      }

      return c.json({
        qrcode: data.qrcode,
        qrcodeUrl: qrcodeDataUri,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate QR code';
      logger.error({ err }, 'WeChat QR code generation failed');
      return c.json({ error: message }, 500);
    }
  });

  configRoutes.get(
    '/user-im/wechat/qrcode-status',
    authMiddleware,
    async (c) => {
      const user = c.get('user') as AuthUser;
      const qrcode = c.req.query('qrcode');
      if (!qrcode) {
        return c.json({ error: 'qrcode query parameter required' }, 400);
      }

      try {
        const url = `${WECHAT_API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        const headers: Record<string, string> = {
          'iLink-App-ClientVersion': '1',
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 35000);
        let res: Response;
        try {
          res = await fetch(url, { headers, signal: controller.signal });
          clearTimeout(timer);
        } catch (err) {
          clearTimeout(timer);
          if (err instanceof Error && err.name === 'AbortError') {
            return c.json({ status: 'wait' });
          }
          throw err;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return c.json(
            { error: `QR status poll failed: ${res.status}`, body },
            502,
          );
        }

        const data = (await res.json()) as {
          status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
          bot_token?: string;
          ilink_bot_id?: string;
          baseurl?: string;
          ilink_user_id?: string;
        };

        if (
          data.status === 'confirmed' &&
          data.bot_token &&
          data.ilink_bot_id
        ) {
          const saved = saveUserWeChatConfig(user.id, {
            botToken: data.bot_token,
            ilinkBotId: data.ilink_bot_id.replace(/[^a-zA-Z0-9@._-]/g, ''),
            baseUrl: data.baseurl || undefined,
            enabled: true,
          });

          const deps = getConfigDeps();
          if (deps?.reloadUserIMConfig) {
            try {
              await deps.reloadUserIMConfig(user.id, 'wechat');
            } catch (err) {
              logger.warn(
                { err, userId: user.id },
                'Failed to hot-reload WeChat after QR login',
              );
            }
          }

          return c.json({
            status: 'confirmed',
            ilinkBotId: saved.ilinkBotId,
          });
        }

        return c.json({
          status: data.status || 'wait',
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'QR status poll failed';
        logger.error({ err }, 'WeChat QR status poll failed');
        return c.json({ error: message }, 500);
      }
    },
  );

  configRoutes.post('/user-im/wechat/disconnect', authMiddleware, async (c) => {
    const user = c.get('user') as AuthUser;
    try {
      const current = getUserWeChatConfig(user.id);
      if (current) {
        saveUserWeChatConfig(user.id, {
          botToken: '',
          ilinkBotId: '',
          enabled: false,
          getUpdatesBuf: current.getUpdatesBuf,
        });
      }

      const deps = getConfigDeps();
      if (deps?.reloadUserIMConfig) {
        try {
          await deps.reloadUserIMConfig(user.id, 'wechat');
        } catch (err) {
          logger.warn({ err, userId: user.id }, 'Failed to disconnect WeChat');
        }
      }

      return c.json({ success: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to disconnect WeChat';
      logger.error({ err }, 'WeChat disconnect failed');
      return c.json({ error: message }, 500);
    }
  });

  configRoutes.put('/user-im/bindings/:imJid', authMiddleware, async (c) => {
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user') as AuthUser;

    const channelType = getChannelFromJid(imJid);
    if (channelType === 'web') {
      return c.json({ error: 'Invalid IM JID' }, 400);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json().catch(() => ({}));

    if (body.unbind === true) {
      const updated: RegisteredGroup = {
        ...imGroup,
        target_main_jid: undefined,
        target_agent_id: undefined,
      };
      applyBindingUpdate(imJid, updated);
      logger.info(
        { imJid, userId: user.id },
        'IM group unbound (bindings page)',
      );
      return c.json({ success: true });
    }

    if (
      typeof body.target_agent_id === 'string' &&
      body.target_agent_id.trim()
    ) {
      const agentId = body.target_agent_id.trim();
      const agent = getAgent(agentId);
      if (!agent) {
        return c.json({ error: 'Agent not found' }, 404);
      }
      if (agent.kind !== 'conversation') {
        return c.json(
          { error: 'Only conversation agents can bind IM groups' },
          400,
        );
      }
      const ownerGroup = getRegisteredGroup(agent.chat_jid);
      if (
        !ownerGroup ||
        !canAccessGroup(user, { ...ownerGroup, jid: agent.chat_jid })
      ) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      const force = body.force === true;
      const replyPolicy =
        body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
      const hasConflict =
        (imGroup.target_agent_id && imGroup.target_agent_id !== agentId) ||
        !!imGroup.target_main_jid;
      if (hasConflict && !force) {
        return c.json({ error: 'IM group is already bound elsewhere' }, 409);
      }

      const updated: RegisteredGroup = {
        ...imGroup,
        target_agent_id: agentId,
        target_main_jid: undefined,
        reply_policy: replyPolicy,
      };
      applyBindingUpdate(imJid, updated);
      logger.info(
        { imJid, agentId, userId: user.id },
        'IM group bound to agent (bindings page)',
      );
      return c.json({ success: true });
    }

    if (
      typeof body.target_main_jid === 'string' &&
      body.target_main_jid.trim()
    ) {
      const targetMainJid = body.target_main_jid.trim();
      const targetGroup = getRegisteredGroup(targetMainJid);
      if (!targetGroup) {
        return c.json({ error: 'Target workspace not found' }, 404);
      }
      if (!canAccessGroup(user, { ...targetGroup, jid: targetMainJid })) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (targetGroup.is_home) {
        return c.json(
          { error: 'Home workspace main conversation uses default IM routing' },
          400,
        );
      }

      const force = body.force === true;
      const replyPolicy =
        body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
      const folderMainJid = `web:${targetGroup.folder}`;
      const hasConflict =
        !!imGroup.target_agent_id ||
        (imGroup.target_main_jid &&
          imGroup.target_main_jid !== targetMainJid &&
          imGroup.target_main_jid !== folderMainJid);
      if (hasConflict && !force) {
        return c.json({ error: 'IM group is already bound elsewhere' }, 409);
      }

      const updated: RegisteredGroup = {
        ...imGroup,
        target_main_jid: targetMainJid,
        target_agent_id: undefined,
        reply_policy: replyPolicy,
      };
      applyBindingUpdate(imJid, updated);
      logger.info(
        { imJid, targetMainJid, userId: user.id },
        'IM group bound to workspace (bindings page)',
      );
      return c.json({ success: true });
    }

    return c.json(
      { error: 'Must provide target_main_jid, target_agent_id, or unbind' },
      400,
    );
  });
}

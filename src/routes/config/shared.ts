import { Agent as HttpsAgent } from 'node:https';

import type { Hono } from 'hono';
import { ProxyAgent } from 'proxy-agent';

import { setRegisteredGroup } from '../../db.js';
import { logger } from '../../logger.js';
import {
  appendClaudeConfigAudit,
  getUserFeishuConfig,
  getUserQQConfig,
  getUserTelegramConfig,
  getUserWeChatConfig,
} from '../../runtime-config.js';
import type { RegisteredGroup } from '../../types.js';
import { getWebDeps, type Variables, type WebDeps } from '../../web-context.js';

export type ConfigRoutesApp = Hono<{ Variables: Variables }>;

let deps: WebDeps | null = null;

export function injectConfigDeps(d: WebDeps): void {
  deps = d;
}

export function getConfigDeps(): WebDeps | null {
  return deps;
}

function requireConfigDeps(): WebDeps {
  if (!deps) {
    throw new Error('Server not initialized');
  }
  return deps;
}

export interface ClaudeApplyResultPayload {
  success: boolean;
  stoppedCount: number;
  failedCount: number;
  error?: string;
}

/**
 * Count how many IM channels are currently enabled for a user, excluding the given channel.
 * Used for billing limit checks when enabling a new channel.
 */
export function countOtherEnabledImChannels(
  userId: string,
  excludeChannel: 'feishu' | 'telegram' | 'qq' | 'wechat',
): number {
  let count = 0;
  if (excludeChannel !== 'feishu' && getUserFeishuConfig(userId)?.enabled) {
    count++;
  }
  if (excludeChannel !== 'telegram' && getUserTelegramConfig(userId)?.enabled) {
    count++;
  }
  if (excludeChannel !== 'wechat' && getUserWeChatConfig(userId)?.enabled) {
    count++;
  }
  if (excludeChannel !== 'qq' && getUserQQConfig(userId)?.enabled) {
    count++;
  }
  return count;
}

export function createTelegramApiAgent(
  proxyUrl?: string,
): HttpsAgent | ProxyAgent {
  if (proxyUrl && proxyUrl.trim()) {
    const fixedProxyUrl = proxyUrl.trim();
    return new ProxyAgent({
      getProxyForUrl: () => fixedProxyUrl,
    });
  }
  return new HttpsAgent({ keepAlive: false, family: 4 });
}

export function destroyTelegramApiAgent(agent: HttpsAgent | ProxyAgent): void {
  agent.destroy();
}

export async function applyClaudeConfigToAllGroups(
  actor: string,
  metadata?: Record<string, unknown>,
): Promise<ClaudeApplyResultPayload> {
  const activeDeps = requireConfigDeps();
  const groupJids = Object.keys(activeDeps.getRegisteredGroups());
  const results = await Promise.allSettled(
    groupJids.map((jid) => activeDeps.queue.stopGroup(jid)),
  );
  const failedCount = results.filter((r) => r.status === 'rejected').length;
  const stoppedCount = groupJids.length - failedCount;

  appendClaudeConfigAudit(actor, 'apply_to_all_flows', ['queue.stopGroup'], {
    stoppedCount,
    failedCount,
    ...(metadata || {}),
  });

  if (failedCount > 0) {
    return {
      success: false,
      stoppedCount,
      failedCount,
      error: `${failedCount} container(s) failed to stop`,
    };
  }

  return {
    success: true,
    stoppedCount,
    failedCount: 0,
  };
}

const deprecationLogged = new Set<string>();

export function logDeprecationOnce(
  endpoint: string,
  replacement: string,
): void {
  if (deprecationLogged.has(endpoint)) return;
  logger.warn(`Deprecated: ${endpoint} — use ${replacement} instead`);
  deprecationLogged.add(endpoint);
}

export function resolveProxyInfo(
  userProxy: string,
  sysProxy: string,
): { effectiveProxyUrl: string; proxySource: 'user' | 'system' | 'none' } {
  return {
    effectiveProxyUrl: userProxy || sysProxy,
    proxySource: userProxy ? 'user' : sysProxy ? 'system' : 'none',
  };
}

/** Persist a RegisteredGroup update and sync to the in-memory cache. */
export function applyBindingUpdate(
  imJid: string,
  updated: RegisteredGroup,
): void {
  setRegisteredGroup(imJid, updated);
  const webDeps = getWebDeps();
  if (webDeps) {
    const groups = webDeps.getRegisteredGroups();
    if (groups[imJid]) groups[imJid] = updated;
    webDeps.clearImFailCounts?.(imJid);
  }
}

export function maskQQAppSecret(secret: string): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return '***';
  return secret.slice(0, 4) + '***' + secret.slice(-4);
}

export function maskBotToken(token: string | undefined): string | null {
  if (!token) return null;
  if (token.length <= 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

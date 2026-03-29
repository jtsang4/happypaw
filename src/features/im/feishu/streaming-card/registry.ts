import { logger } from '../../../../logger.js';
import { StreamingCardController } from './controller.js';

// ─── MessageId → ChatJid Mapping ─────────────────────────────
// Reverse lookup for card callback: given a Feishu messageId from a button click,
// find which chatJid (streaming session) it belongs to.

const messageIdToChatJid = new Map<string, string>();

/**
 * Register a messageId → chatJid mapping for card callback routing.
 */
export function registerMessageIdMapping(
  messageId: string,
  chatJid: string,
): void {
  messageIdToChatJid.set(messageId, chatJid);
}

/**
 * Resolve a chatJid from a Feishu messageId.
 */
export function resolveJidByMessageId(messageId: string): string | undefined {
  return messageIdToChatJid.get(messageId);
}

/**
 * Remove a messageId mapping.
 */
export function unregisterMessageId(messageId: string): void {
  messageIdToChatJid.delete(messageId);
}

// ─── Streaming Session Registry ───────────────────────────────
// Global registry for tracking active streaming sessions.
// Used by shutdown hooks to abort all active sessions.

const activeSessions = new Map<string, StreamingCardController>();

/**
 * Register a streaming session for a chatJid.
 * Replaces any existing session for the same chatJid.
 */
export function registerStreamingSession(
  chatJid: string,
  session: StreamingCardController,
): void {
  const existing = activeSessions.get(chatJid);
  if (existing && existing.isActive()) {
    // Abort (not just dispose) so the old card shows "已中断" instead of stuck "生成中..."
    existing.abort('新的回复已开始').catch(() => {});
  }
  activeSessions.set(chatJid, session);
}

/**
 * Remove a streaming session from the registry.
 * Also cleans up all messageId → chatJid mappings (including multi-card).
 */
export function unregisterStreamingSession(chatJid: string): void {
  const session = activeSessions.get(chatJid);
  if (session) {
    for (const msgId of session.getAllMessageIds()) {
      unregisterMessageId(msgId);
    }
  }
  activeSessions.delete(chatJid);
}

/**
 * Get the active streaming session for a chatJid.
 */
export function getStreamingSession(
  chatJid: string,
): StreamingCardController | undefined {
  return activeSessions.get(chatJid);
}

/**
 * Check if there's an active streaming session for a chatJid.
 */
export function hasActiveStreamingSession(chatJid: string): boolean {
  const session = activeSessions.get(chatJid);
  return session?.isActive() ?? false;
}

/**
 * Abort all active streaming sessions.
 * Called during graceful shutdown.
 */
export async function abortAllStreamingSessions(
  reason = '服务维护中',
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [chatJid, session] of activeSessions.entries()) {
    if (session.isActive()) {
      promises.push(
        session.abort(reason).catch((err) => {
          logger.debug(
            { err, chatJid },
            'Failed to abort streaming session during shutdown',
          );
        }),
      );
    }
  }
  await Promise.allSettled(promises);
  // Clean up messageId → chatJid mappings before clearing sessions
  for (const session of activeSessions.values()) {
    for (const msgId of session.getAllMessageIds()) {
      unregisterMessageId(msgId);
    }
  }
  activeSessions.clear();
  logger.info({ count: promises.length }, 'All streaming sessions aborted');
}

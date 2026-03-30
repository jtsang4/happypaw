import type { RuntimeSessionRecord } from '../../shared/types.js';
import type { RuntimeSessionScope } from '../../db.js';

export interface ConversationActivationContext {
  sessionId?: string;
  chatJid?: string;
  replyRouteJid?: string | null;
  sessionScope?: RuntimeSessionScope;
}

export function getConversationSessionScope(
  conversationJid: string,
): RuntimeSessionScope | undefined {
  if (conversationJid.startsWith('web:')) return undefined;
  return { conversationId: conversationJid };
}

export function buildConversationActivationContext(
  groupFolder: string,
  conversationJid: string,
  chatJid: string,
  replyRouteJid: string | null,
  getRuntimeSession?: (
    groupFolder: string,
    scope?: string | RuntimeSessionScope | null,
  ) => RuntimeSessionRecord | undefined,
): ConversationActivationContext {
  const sessionScope = getConversationSessionScope(conversationJid);
  const sessionRecord = getRuntimeSession?.(groupFolder, sessionScope);
  return {
    sessionId: sessionRecord?.sessionId,
    chatJid,
    replyRouteJid,
    sessionScope,
  };
}

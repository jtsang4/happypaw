import crypto from 'crypto';

import {
  checkBillingAccess,
  formatBillingAccessDeniedMessage,
} from '../../features/billing/billing.js';
import {
  ensureChatExists,
  getAgent,
  getRegisteredGroup,
  getUserById,
  isGroupShared,
  storeMessageDirect,
} from '../../db.js';
import { logger } from '../logger.js';
import { ASSISTANT_NAME } from '../config.js';
import {
  normalizeImageAttachments,
  toAgentImages,
} from '../../features/im/messaging/attachments.js';
import { buildConversationActivationContext } from '../../features/chat-runtime/session-scope.js';
import type { RuntimeSessionScope } from '../../db.js';

type ImageAttachment = {
  type: 'image';
  data: string;
  mimeType?: string;
};

interface MessageIngressDeps {
  getWebDeps: () => {
    queue: {
      sendMessage: (
        chatJid: string,
        message: string,
        images?: Array<{ data: string; mimeType: string }>,
        onSent?: () => void,
        context?: {
          sessionId?: string;
          chatJid?: string;
          replyRouteJid?: string | null;
          sessionScope?: RuntimeSessionScope;
        },
      ) => 'sent' | 'no_active';
      enqueueMessageCheck: (chatJid: string) => void;
      markIpcInjectedMessage: (chatJid: string) => void;
      closeStdin: (chatJid: string) => void;
      enqueueTask: (
        chatJid: string,
        taskId: string,
        task: () => Promise<void>,
      ) => void;
    };
    getRegisteredGroups: () => Record<
      string,
      { created_by?: string; is_home?: boolean; folder: string }
    >;
    getRuntimeSession?: (
      groupFolder: string,
      scope?: string | RuntimeSessionScope | null,
    ) => { sessionId: string } | undefined;
    formatMessages: (
      messages: Array<{
        id: string;
        chat_jid: string;
        sender: string;
        sender_name: string;
        content: string;
        timestamp: string;
      }>,
      isShared?: boolean,
    ) => string;
    setLastAgentTimestamp: (
      jid: string,
      cursor: { timestamp: string; id: string },
    ) => void;
    advanceGlobalCursor: (cursor: { timestamp: string; id: string }) => void;
    updateReplyRoute?: (folder: string, sourceJid: string | null) => void;
    processAgentConversation?: (
      chatJid: string,
      agentId: string,
    ) => Promise<void>;
  } | null;
  broadcastNewMessage: (
    chatJid: string,
    msg: {
      id: string;
      chat_jid: string;
      sender: string;
      sender_name: string;
      content: string;
      timestamp: string;
      is_from_me?: boolean;
      attachments?: string;
    },
    agentId?: string,
  ) => void;
}

export function createMessageIngress({
  getWebDeps,
  broadcastNewMessage,
}: MessageIngressDeps) {
  async function handleWebUserMessage(
    chatJid: string,
    content: string,
    attachments?: ImageAttachment[],
    userId = 'web-user',
    displayName = 'Web',
  ): Promise<
    | {
        ok: true;
        messageId: string;
        timestamp: string;
      }
    | {
        ok: false;
        status: 404 | 500;
        error: string;
      }
  > {
    const deps = getWebDeps();
    if (!deps)
      return { ok: false, status: 500, error: 'Server not initialized' };

    let group = deps.getRegisteredGroups()[chatJid];
    if (!group) {
      const dbGroup = getRegisteredGroup(chatJid);
      if (!dbGroup) return { ok: false, status: 404, error: 'Group not found' };
      group = dbGroup;
    }

    ensureChatExists(chatJid);

    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const normalizedAttachments = normalizeImageAttachments(attachments, {
      onMimeMismatch: ({ declaredMime, detectedMime }) => {
        logger.warn(
          { chatJid, messageId, declaredMime, detectedMime },
          'Web attachment MIME mismatch detected, using detected MIME',
        );
      },
    });
    const attachmentsStr =
      normalizedAttachments.length > 0
        ? JSON.stringify(normalizedAttachments)
        : undefined;

    storeMessageDirect(
      messageId,
      chatJid,
      userId,
      displayName,
      content,
      timestamp,
      false,
      { attachments: attachmentsStr },
    );

    broadcastNewMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: userId,
      sender_name: displayName,
      content,
      timestamp,
      is_from_me: false,
      attachments: attachmentsStr,
    });

    if (group.created_by) {
      const owner = getUserById(group.created_by);
      if (owner && owner.role !== 'admin') {
        const accessResult = checkBillingAccess(group.created_by, owner.role);
        if (!accessResult.allowed) {
          const sysMsg = formatBillingAccessDeniedMessage(accessResult);
          const sysMsgId = `sys_quota_${Date.now()}`;
          const sysTimestamp = new Date().toISOString();
          storeMessageDirect(
            sysMsgId,
            chatJid,
            '__billing__',
            ASSISTANT_NAME,
            sysMsg,
            sysTimestamp,
            true,
          );
          broadcastNewMessage(chatJid, {
            id: sysMsgId,
            chat_jid: chatJid,
            sender: '__billing__',
            sender_name: ASSISTANT_NAME,
            content: sysMsg,
            timestamp: sysTimestamp,
            is_from_me: true,
          });
          deps.setLastAgentTimestamp(chatJid, { timestamp, id: messageId });
          deps.advanceGlobalCursor({ timestamp, id: messageId });
          return { ok: true, messageId, timestamp };
        }
      }
    }

    const shared = !group.is_home && isGroupShared(group.folder);
    const formatted = deps.formatMessages(
      [
        {
          id: messageId,
          chat_jid: chatJid,
          sender: userId,
          sender_name: displayName,
          content,
          timestamp,
        },
      ],
      shared,
    );

    let pipedToActive = false;
    const images = toAgentImages(normalizedAttachments);
    const activationContext = buildConversationActivationContext(
      group.folder,
      chatJid,
      chatJid,
      null,
      deps.getRuntimeSession,
    );
    const sendResult = deps.queue.sendMessage(
      chatJid,
      formatted,
      images,
      () => {
        deps.updateReplyRoute?.(group.folder, null);
      },
      {
        sessionId: activationContext.sessionId,
        chatJid,
        replyRouteJid: null,
        sessionScope: activationContext.sessionScope,
      },
    );
    if (sendResult === 'sent') {
      pipedToActive = true;
    } else {
      deps.queue.enqueueMessageCheck(chatJid);
    }

    if (pipedToActive) {
      deps.setLastAgentTimestamp(chatJid, { timestamp, id: messageId });
      deps.queue.markIpcInjectedMessage(chatJid);
    }
    deps.advanceGlobalCursor({ timestamp, id: messageId });
    return { ok: true, messageId, timestamp };
  }

  async function handleAgentConversationMessage(
    chatJid: string,
    agentId: string,
    content: string,
    userId: string,
    displayName: string,
    attachments?: ImageAttachment[],
  ): Promise<void> {
    const deps = getWebDeps();
    if (!deps) return;

    const agent = getAgent(agentId);
    if (!agent || agent.kind !== 'conversation' || agent.chat_jid !== chatJid) {
      logger.warn(
        { chatJid, agentId },
        'Agent conversation message rejected: agent not found or not a conversation',
      );
      return;
    }

    const virtualChatJid = `${chatJid}#agent:${agentId}`;
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const normalizedAttachments = normalizeImageAttachments(attachments, {
      onMimeMismatch: ({ declaredMime, detectedMime }) => {
        logger.warn(
          { chatJid, messageId, agentId, declaredMime, detectedMime },
          'Agent conversation attachment MIME mismatch detected, using detected MIME',
        );
      },
    });
    const attachmentsStr =
      normalizedAttachments.length > 0
        ? JSON.stringify(normalizedAttachments)
        : undefined;

    ensureChatExists(virtualChatJid);
    storeMessageDirect(
      messageId,
      virtualChatJid,
      userId,
      displayName,
      content,
      timestamp,
      false,
      { attachments: attachmentsStr },
    );

    broadcastNewMessage(
      virtualChatJid,
      {
        id: messageId,
        chat_jid: virtualChatJid,
        sender: userId,
        sender_name: displayName,
        content,
        timestamp,
        is_from_me: false,
        attachments: attachmentsStr,
      },
      agentId,
    );

    const formatted = deps.formatMessages(
      [
        {
          id: messageId,
          chat_jid: virtualChatJid,
          sender: userId,
          sender_name: displayName,
          content,
          timestamp,
        },
      ],
      false,
    );

    const agentSendResult = deps.queue.sendMessage(
      virtualChatJid,
      formatted,
      toAgentImages(normalizedAttachments),
      undefined,
      {
        chatJid,
      },
    );
    if (agentSendResult === 'no_active') {
      deps.queue.closeStdin(virtualChatJid);
      if (deps.processAgentConversation) {
        const taskId = `agent-conv:${agentId}:${Date.now()}`;
        deps.queue.enqueueTask(virtualChatJid, taskId, async () => {
          await deps.processAgentConversation!(chatJid, agentId);
        });
      }
    }
  }

  return {
    handleWebUserMessage,
    handleAgentConversationMessage,
  };
}

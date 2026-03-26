import { interruptibleSleep } from './message-notifier.js';
import { getChannelType } from './im-channel.js';
import {
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getUserById,
} from './db.js';
import {
  checkBillingAccessFresh,
  formatBillingAccessDeniedMessage,
} from './billing.js';
import { logger } from './logger.js';
import type { GroupQueue } from './group-queue.js';
import type { MessageCursor, NewMessage, RegisteredGroup } from './types.js';

export function createMessageLoop(deps: {
  queue: GroupQueue;
  pollInterval: number;
  emptyCursor: MessageCursor;
  registeredGroups: Record<string, RegisteredGroup>;
  lastAgentTimestamp: Record<string, MessageCursor>;
  recoveryGroups: Set<string>;
  getGlobalMessageCursor: () => MessageCursor;
  setGlobalMessageCursor: (cursor: MessageCursor) => void;
  saveState: () => void;
  setCursors: (jid: string, cursor: MessageCursor) => void;
  getStuckRunnerCheckCounter: () => number;
  resetStuckRunnerCheckCounter: () => void;
  incrementStuckRunnerCheckCounter: () => number;
  stuckRunnerCheckIntervalPolls: number;
  recoverStuckPendingGroups: () => void;
  isShuttingDown: () => boolean;
  formatMessages: (messages: NewMessage[], isShared?: boolean) => string;
  collectMessageImages: (
    chatJid: string,
    messages: NewMessage[],
  ) => Array<{ data: string; mimeType: string }>;
  isGroupShared: (folder: string) => boolean;
  sendBillingDeniedMessage: (jid: string, content: string) => string;
  imManager: {
    sendMessage: (jid: string, text: string) => Promise<void>;
  };
  activeRouteUpdaters: Map<string, (newSourceJid: string | null) => void>;
}): {
  startMessageLoop: () => Promise<void>;
} {
  let messageLoopRunning = false;

  async function startMessageLoop(): Promise<void> {
    if (messageLoopRunning) {
      logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    messageLoopRunning = true;

    logger.info('happypaw running');

    while (!deps.isShuttingDown()) {
      try {
        const jids = Object.keys(deps.registeredGroups);
        const { messages, newCursor } = getNewMessages(
          jids,
          deps.getGlobalMessageCursor(),
        );

        if (messages.length > 0) {
          logger.info({ count: messages.length }, 'New messages');

          deps.setGlobalMessageCursor(newCursor);
          deps.saveState();

          const messagesByGroup = new Map<string, NewMessage[]>();
          for (const msg of messages) {
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) {
              existing.push(msg);
            } else {
              messagesByGroup.set(msg.chat_jid, [msg]);
            }
          }

          for (const [chatJid, groupMessages] of messagesByGroup) {
            let group = deps.registeredGroups[chatJid];
            if (!group) {
              const dbGroup = getRegisteredGroup(chatJid);
              if (dbGroup) {
                deps.registeredGroups[chatJid] = dbGroup;
                group = dbGroup;
              }
            }
            if (!group) continue;
            if (group.target_agent_id) continue;

            if (group.created_by) {
              const owner = getUserById(group.created_by);
              if (owner && owner.role !== 'admin') {
                const accessResult = checkBillingAccessFresh(
                  group.created_by,
                  owner.role,
                );
                if (!accessResult.allowed) {
                  logger.info(
                    {
                      chatJid,
                      userId: group.created_by,
                      reason: accessResult.reason,
                      blockType: accessResult.blockType,
                      exceededWindow: accessResult.exceededWindow,
                    },
                    'Billing access denied, blocking message processing',
                  );
                  const sysMsg = formatBillingAccessDeniedMessage(accessResult);
                  deps.sendBillingDeniedMessage(chatJid, sysMsg);

                  const lastSourceJid =
                    groupMessages[groupMessages.length - 1]?.source_jid;
                  const imSourceJid = lastSourceJid || chatJid;
                  if (getChannelType(imSourceJid)) {
                    deps.imManager
                      .sendMessage(imSourceJid, sysMsg)
                      .catch((err) =>
                        logger.warn(
                          { err, jid: imSourceJid },
                          'Failed to send quota exceeded notice to IM',
                        ),
                      );
                  }

                  const lastMsg = groupMessages[groupMessages.length - 1];
                  deps.setCursors(chatJid, {
                    timestamp: lastMsg.timestamp,
                    id: lastMsg.id,
                  });
                  continue;
                }
              }
            }

            const allPending = getMessagesSince(
              chatJid,
              deps.lastAgentTimestamp[chatJid] || deps.emptyCursor,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;

            const shared = !group.is_home && deps.isGroupShared(group.folder);
            const formatted = deps.formatMessages(messagesToSend, shared);
            const images = deps.collectMessageImages(chatJid, messagesToSend);
            const imagesForAgent = images.length > 0 ? images : undefined;
            const lastSourceJidForRoute =
              messagesToSend[messagesToSend.length - 1]?.source_jid || chatJid;

            const sendResult = deps.queue.sendMessage(
              chatJid,
              formatted,
              imagesForAgent,
              () => {
                deps.activeRouteUpdaters.get(group.folder)?.(
                  lastSourceJidForRoute,
                );
              },
            );
            if (sendResult === 'sent') {
              logger.debug(
                {
                  chatJid,
                  count: messagesToSend.length,
                  imageCount: images.length,
                },
                'Piped messages to active container',
              );
              const lastProcessed = messagesToSend[messagesToSend.length - 1];
              deps.lastAgentTimestamp[chatJid] = {
                timestamp: lastProcessed.timestamp,
                id: lastProcessed.id,
              };
              deps.saveState();
            } else {
              deps.queue.enqueueMessageCheck(chatJid);
            }
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error in message loop');
      }

      const counter = deps.incrementStuckRunnerCheckCounter();
      if (counter >= deps.stuckRunnerCheckIntervalPolls) {
        deps.resetStuckRunnerCheckCounter();
        deps.recoverStuckPendingGroups();
      }

      await interruptibleSleep(deps.pollInterval);
    }
  }

  return { startMessageLoop };
}

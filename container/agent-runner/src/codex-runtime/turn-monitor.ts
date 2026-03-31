import type { FollowUpMessage } from './shared.js';

const INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;

function combineQueuedMessages(
  messages: FollowUpMessage[],
): FollowUpMessage | undefined {
  if (messages.length === 0) return undefined;

  const text = messages.map((message) => message.text).join('\n');
  const images = messages.flatMap((message) => message.images ?? []);
  const latestMessage = messages[messages.length - 1];

  return {
    text,
    images: images.length > 0 ? images : undefined,
    sessionId: latestMessage?.sessionId,
    chatJid: latestMessage?.chatJid,
    replyRouteJid: latestMessage?.replyRouteJid,
  };
}

export function shouldTreatFollowUpAsRebindBoundary(
  message: {
    sessionId?: string;
    chatJid?: string;
    replyRouteJid?: string;
  },
  activeTurn: {
    sessionId?: string;
    chatJid?: string;
    replyRouteJid?: string;
  },
): boolean {
  return (
    (typeof message.sessionId === 'string' &&
      message.sessionId !== activeTurn.sessionId) ||
    (typeof message.chatJid === 'string' &&
      message.chatJid !== activeTurn.chatJid) ||
    (typeof message.replyRouteJid === 'string' &&
      message.replyRouteJid !== activeTurn.replyRouteJid)
  );
}

export async function waitForTurnCompletion(options: {
  shouldClose: () => boolean;
  shouldInterrupt: () => boolean;
  shouldDrain: () => boolean;
  drainIpcInput?: () => {
    messages: FollowUpMessage[];
  };
  canSteer?: () => boolean;
  isTurnComplete: () => boolean;
  onInterrupt: (reason: 'closed' | 'interrupted') => Promise<void>;
  onSteer?: (message: FollowUpMessage) => Promise<void>;
  log?: (message: string) => void;
}): Promise<{
  state: 'completed' | 'closed' | 'interrupted';
  drainRequested: boolean;
  deferredFollowUp?: FollowUpMessage;
}> {
  let closeRequested = false;
  let interruptRequested = false;
  let interruptSentAt = 0;
  let drainRequested = false;
  const deferredMessages: FollowUpMessage[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (options.isTurnComplete()) {
      return {
        state: closeRequested
          ? 'closed'
          : interruptRequested
            ? 'interrupted'
            : 'completed',
        drainRequested,
        deferredFollowUp: combineQueuedMessages(deferredMessages),
      };
    }
    if (!closeRequested && options.shouldClose()) {
      closeRequested = true;
      interruptSentAt = Date.now();
      await options.onInterrupt('closed');
    }
    if (!interruptRequested && options.shouldInterrupt()) {
      interruptRequested = true;
      interruptSentAt = Date.now();
      await options.onInterrupt('interrupted');
    }
    if (!drainRequested && options.shouldDrain()) {
      drainRequested = true;
    }
    if (
      !closeRequested &&
      !interruptRequested &&
      !drainRequested &&
      options.drainIpcInput &&
      (options.canSteer?.() ?? true) &&
      options.onSteer
    ) {
      const followUp = combineQueuedMessages(options.drainIpcInput().messages);
      if (followUp) {
        try {
          await options.onSteer(followUp);
        } catch (error) {
          options.log?.(
            `turn/steer failed, deferring message to next turn: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          deferredMessages.push(followUp);
        }
      }
    }
    if (
      interruptSentAt > 0 &&
      Date.now() - interruptSentAt >= INTERRUPT_SETTLE_TIMEOUT_MS
    ) {
      return {
        state: closeRequested ? 'closed' : 'interrupted',
        drainRequested,
        deferredFollowUp: combineQueuedMessages(deferredMessages),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export { combineQueuedMessages };

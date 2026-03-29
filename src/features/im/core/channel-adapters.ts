import {
  createFeishuConnection,
  type FeishuConnection,
  type FeishuConnectionConfig,
} from '../channels/feishu/index.js';
import {
  StreamingCardController,
  type StreamingCardOptions,
} from '../channels/feishu/streaming-card/index.js';
import { logger } from '../../../logger.js';
import {
  createQQConnection,
  type QQConnection,
  type QQConnectionConfig,
} from '../channels/qq/connection.js';
import {
  createTelegramConnection,
  type TelegramConnection,
  type TelegramConnectionConfig,
} from '../channels/telegram/connection.js';
import {
  createWeChatConnection,
  type WeChatConnection,
  type WeChatConnectionConfig,
} from '../channels/wechat/connection.js';
import type { IMChannel, IMChannelConnectOpts } from './channel-types.js';

export function createFeishuChannel(config: FeishuConnectionConfig): IMChannel {
  let inner: FeishuConnection | null = null;

  return {
    channelType: 'feishu',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createFeishuConnection(config);
      const connected = await inner.connect({
        onReady: opts.onReady,
        onNewChat: opts.onNewChat,
        ignoreMessagesBefore: opts.ignoreMessagesBefore,
        onCommand: opts.onCommand,
        resolveGroupFolder: opts.resolveGroupFolder,
        resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
        onAgentMessage: opts.onAgentMessage,
        onBotAddedToGroup: opts.onBotAddedToGroup,
        onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
        shouldProcessGroupMessage: opts.shouldProcessGroupMessage,
        onCardInterrupt: opts.onCardInterrupt,
      });
      if (!connected) inner = null;
      return connected;
    },

    async disconnect(): Promise<void> {
      if (!inner) return;
      await inner.stop();
      inner = null;
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Feishu channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Feishu channel not connected, skip sending image',
        );
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Feishu channel not connected, skip sending file',
        );
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!inner) return;
      await inner.sendReaction(chatId, isTyping);
    },

    clearAckReaction(chatId: string): void {
      inner?.clearAckReaction(chatId);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },

    async syncGroups(): Promise<void> {
      if (!inner) return;
      await inner.syncGroups();
    },

    async getChatInfo(chatId: string) {
      if (!inner) return null;
      return inner.getChatInfo(chatId);
    },

    createStreamingSession(
      chatId: string,
      onCardCreated?: (messageId: string) => void,
    ): StreamingCardController | undefined {
      if (!inner) return undefined;
      const larkClient = inner.getLarkClient();
      if (!larkClient) return undefined;
      const opts: StreamingCardOptions = {
        client: larkClient,
        chatId,
        replyToMsgId: inner.getLastMessageId(chatId),
        onCardCreated,
      };
      return new StreamingCardController(opts);
    },
  };
}

export function createTelegramChannel(
  config: TelegramConnectionConfig,
): IMChannel {
  let inner: TelegramConnection | null = null;
  let typingTimer: NodeJS.Timeout | null = null;

  function clearTypingTimer(): void {
    if (!typingTimer) return;
    clearInterval(typingTimer);
    typingTimer = null;
  }

  return {
    channelType: 'telegram',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createTelegramConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          isChatAuthorized: opts.isChatAuthorized ?? (() => true),
          onPairAttempt: opts.onPairAttempt,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
          onBotAddedToGroup: opts.onBotAddedToGroup,
          onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'Telegram channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      clearTypingTimer();
      if (!inner) return;
      await inner.disconnect();
      inner = null;
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Telegram channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Telegram channel not connected, skip sending image',
        );
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Telegram channel not connected, skip sending file',
        );
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      clearTypingTimer();
      if (!isTyping || !inner) return;

      const sendAction = async (): Promise<void> => {
        if (!inner) return;
        await inner.sendChatAction(chatId, 'typing');
      };

      void sendAction();
      typingTimer = setInterval(() => {
        void sendAction();
      }, 4000);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },
  };
}

export function createQQChannel(config: QQConnectionConfig): IMChannel {
  let inner: QQConnection | null = null;

  return {
    channelType: 'qq',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createQQConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          isChatAuthorized: opts.isChatAuthorized ?? (() => true),
          onPairAttempt: opts.onPairAttempt,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'QQ channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      if (!inner) return;
      await inner.disconnect();
      inner = null;
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'QQ channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text);
    },

    async setTyping(_chatId: string, _isTyping: boolean): Promise<void> {},

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },
  };
}

export function createWeChatChannel(config: WeChatConnectionConfig): IMChannel {
  let inner: WeChatConnection | null = null;

  return {
    channelType: 'wechat',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createWeChatConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'WeChat channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      if (!inner) return;
      await inner.disconnect();
      inner = null;
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'WeChat channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text);
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!inner) return;
      await inner.sendTyping(chatId, isTyping);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },
  };
}

import {
  createFeishuChannel,
  createQQChannel,
  createTelegramChannel,
  createWeChatChannel,
} from './channel-adapters.js';
import { extractChatId, getChannelType } from './channel-routing.js';
import type { IMChannel, IMChannelConnectOpts } from './channel-types.js';
import type { StreamingCardController } from '../channels/feishu/streaming-card/index.js';
import { logger } from '../../../app/logger.js';
import { IMConnectionPool } from './connection-pool.js';
import { findChannelForJid } from './routing-helpers.js';
import type {
  ConnectFeishuOptions,
  ConnectQQOptions,
  ConnectTelegramOptions,
  ConnectWeChatOptions,
  FeishuConnectConfig,
  QQConnectConfig,
  TelegramConnectConfig,
  WeChatConnectConfig,
} from './manager.types.js';

class IMConnectionManager {
  private readonly pool = new IMConnectionPool();

  // ─── Generic Channel Methods ────────────────────────────────

  /**
   * Connect any IMChannel for a user.
   */
  async connectChannel(
    userId: string,
    channelType: string,
    channel: IMChannel,
    opts: IMChannelConnectOpts,
  ): Promise<boolean> {
    return this.pool.connectChannel(userId, channelType, channel, opts);
  }

  /**
   * Disconnect a specific channel type for a user.
   */
  async disconnectChannel(userId: string, channelType: string): Promise<void> {
    await this.pool.disconnectChannel(userId, channelType);
  }

  /**
   * Send a message to an IM chat, auto-routing via JID prefix.
   * Resolves the user by looking up chatJid -> registered_groups.created_by.
   * Falls back to iterating sibling groups if no created_by is set.
   */
  async sendMessage(
    jid: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) {
      logger.debug({ jid }, 'Unknown channel type for JID, skip sending');
      return;
    }

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (!channel) {
      throw new Error(`No IM channel available for ${jid} (${channelType})`);
    }
    await channel.sendMessage(chatId, text, localImagePaths);
  }

  /**
   * Send an image to an IM chat, auto-routing via JID prefix.
   */
  async sendImage(
    jid: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) {
      logger.debug({ jid }, 'Unknown channel type for JID, skip sending image');
      return;
    }

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.sendImage) {
      await channel.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
      return;
    }

    // Fallback: if channel doesn't support sendImage, send caption as text
    if (caption && channel) {
      await channel.sendMessage(chatId, `📷 ${caption}`);
      return;
    }

    logger.warn({ jid, channelType }, 'No IM channel available to send image');
  }

  /**
   * Send a file to an IM chat, auto-routing via JID prefix.
   * @throws Error if the channel doesn't support file sending
   */
  async sendFile(
    jid: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) {
      throw new Error(`无法识别 JID 的通道类型: ${jid}`);
    }

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.sendFile) {
      await channel.sendFile(chatId, filePath, fileName);
    } else {
      throw new Error(`通道 ${channelType} 不支持发送文件`);
    }
  }

  /**
   * Set typing indicator on an IM chat, auto-routing via JID prefix.
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) return;

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel) {
      await channel.setTyping(chatId, isTyping);
    }
    // No fallback for typing — silently ignore if owner's connection is unavailable
  }

  /**
   * Clear the ack reaction for a chat (e.g. when streaming card handled the reply).
   */
  clearAckReaction(jid: string): void {
    const channelType = getChannelType(jid);
    if (!channelType) return;

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.clearAckReaction) {
      channel.clearAckReaction(chatId);
    }
  }

  /**
   * Create a streaming card session for an IM chat (Feishu only).
   * Returns undefined for non-Feishu channels or if not supported.
   */
  createStreamingSession(
    jid: string,
    onCardCreated?: (messageId: string) => void,
  ): StreamingCardController | undefined {
    const channelType = getChannelType(jid);
    if (channelType !== 'feishu') return undefined;

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.createStreamingSession) {
      return channel.createStreamingSession(chatId, onCardCreated);
    }
    return undefined;
  }

  /**
   * Find the appropriate IMChannel for a given JID, using group ownership lookup
   * and sibling fallback.
   */
  private findChannelForJid(
    jid: string,
    channelType: string,
  ): IMChannel | undefined {
    return findChannelForJid(this.pool.getConnections(), jid, channelType);
  }

  /**
   * Get all connected channel types for a user.
   * Used by scheduled task IM broadcast to discover available channels.
   */
  getConnectedChannelTypes(userId: string): string[] {
    return this.pool.getConnectedChannelTypes(userId);
  }

  /**
   * Check if a specific JID has a connected channel available.
   * Uses the same routing logic as sendMessage (group ownership + sibling fallback).
   */
  isChannelAvailableForJid(jid: string): boolean {
    const channelType = getChannelType(jid);
    if (!channelType) return false;
    return !!this.findChannelForJid(jid, channelType);
  }

  // ─── Convenience Methods (API-compatible wrappers) ──────────

  /**
   * Connect a Feishu instance for a specific user.
   */
  async connectUserFeishu(
    userId: string,
    config: FeishuConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    options?: ConnectFeishuOptions,
  ): Promise<boolean> {
    if (!config.appId || !config.appSecret) {
      logger.info({ userId }, 'Feishu config empty, skipping connection');
      return false;
    }

    const channel = createFeishuChannel({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    return this.connectChannel(userId, 'feishu', channel, {
      onReady: () => {
        logger.info({ userId }, 'User Feishu WebSocket connected');
      },
      onNewChat,
      ignoreMessagesBefore: options?.ignoreMessagesBefore,
      onCommand: options?.onCommand,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
      onBotAddedToGroup: options?.onBotAddedToGroup,
      onBotRemovedFromGroup: options?.onBotRemovedFromGroup,
      shouldProcessGroupMessage: options?.shouldProcessGroupMessage,
      onCardInterrupt: options?.onCardInterrupt,
    });
  }

  /**
   * Connect a Telegram instance for a specific user.
   */
  async connectUserTelegram(
    userId: string,
    config: TelegramConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    isChatAuthorized?: (jid: string) => boolean,
    onPairAttempt?: (
      jid: string,
      chatName: string,
      code: string,
    ) => Promise<boolean>,
    options?: ConnectTelegramOptions,
  ): Promise<boolean> {
    if (!config.botToken) {
      logger.info({ userId }, 'Telegram config empty, skipping connection');
      return false;
    }

    const channel = createTelegramChannel({
      botToken: config.botToken,
      proxyUrl: config.proxyUrl,
    });

    return this.connectChannel(userId, 'telegram', channel, {
      onReady: () => {
        logger.info({ userId }, 'User Telegram bot connected');
      },
      onNewChat,
      isChatAuthorized,
      onPairAttempt,
      onCommand: options?.onCommand,
      ignoreMessagesBefore: options?.ignoreMessagesBefore,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
      onBotAddedToGroup: options?.onBotAddedToGroup,
      onBotRemovedFromGroup: options?.onBotRemovedFromGroup,
    });
  }

  /**
   * Connect a QQ instance for a specific user.
   */
  async connectUserQQ(
    userId: string,
    config: QQConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    isChatAuthorized?: (jid: string) => boolean,
    onPairAttempt?: (
      jid: string,
      chatName: string,
      code: string,
    ) => Promise<boolean>,
    options?: ConnectQQOptions,
  ): Promise<boolean> {
    if (!config.appId || !config.appSecret) {
      logger.info({ userId }, 'QQ config empty, skipping connection');
      return false;
    }

    const channel = createQQChannel({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    return this.connectChannel(userId, 'qq', channel, {
      onReady: () => {
        logger.info({ userId }, 'User QQ bot connected');
      },
      onNewChat,
      isChatAuthorized,
      onPairAttempt,
      onCommand: options?.onCommand,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
    });
  }

  async disconnectUserFeishu(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'feishu');
  }

  async disconnectUserTelegram(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'telegram');
  }

  async disconnectUserQQ(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'qq');
  }

  /**
   * Connect a WeChat iLink instance for a specific user.
   */
  async connectUserWeChat(
    userId: string,
    config: WeChatConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    options?: ConnectWeChatOptions,
  ): Promise<boolean> {
    if (!config.botToken || !config.ilinkBotId) {
      logger.info({ userId }, 'WeChat config empty, skipping connection');
      return false;
    }

    const channel = createWeChatChannel({
      botToken: config.botToken,
      ilinkBotId: config.ilinkBotId,
      baseUrl: config.baseUrl,
      cdnBaseUrl: config.cdnBaseUrl,
      getUpdatesBuf: config.getUpdatesBuf,
    });

    return this.connectChannel(userId, 'wechat', channel, {
      onReady: () => {
        logger.info({ userId }, 'User WeChat bot connected');
      },
      onNewChat,
      ignoreMessagesBefore: options?.ignoreMessagesBefore,
      onCommand: options?.onCommand,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
    });
  }

  async disconnectUserWeChat(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'wechat');
  }

  async sendFeishuMessage(
    chatJid: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void> {
    await this.sendMessage(chatJid, text, localImagePaths);
  }

  async sendTelegramMessage(
    chatJid: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void> {
    await this.sendMessage(chatJid, text, localImagePaths);
  }

  async setFeishuTyping(chatJid: string, isTyping: boolean): Promise<void> {
    await this.setTyping(chatJid, isTyping);
  }

  async setTelegramTyping(chatJid: string, isTyping: boolean): Promise<void> {
    await this.setTyping(chatJid, isTyping);
  }

  /**
   * Sync Feishu groups via a specific user's connection.
   */
  async syncFeishuGroups(userId: string): Promise<void> {
    const channel = this.pool.getUserChannel(userId, 'feishu');
    if (channel?.isConnected() && channel.syncGroups) {
      await channel.syncGroups();
    }
  }

  isFeishuConnected(userId: string): boolean {
    return this.pool.isUserChannelConnected(userId, 'feishu');
  }

  isTelegramConnected(userId: string): boolean {
    return this.pool.isUserChannelConnected(userId, 'telegram');
  }

  isQQConnected(userId: string): boolean {
    return this.pool.isUserChannelConnected(userId, 'qq');
  }

  /** Check if any user has an active Feishu connection */
  isAnyFeishuConnected(): boolean {
    return this.pool.isAnyChannelConnected('feishu');
  }

  /** Check if any user has an active Telegram connection */
  isAnyTelegramConnected(): boolean {
    return this.pool.isAnyChannelConnected('telegram');
  }

  /** Check if any user has an active QQ connection */
  isAnyQQConnected(): boolean {
    return this.pool.isAnyChannelConnected('qq');
  }

  isWeChatConnected(userId: string): boolean {
    return this.pool.isUserChannelConnected(userId, 'wechat');
  }

  /** Check if any user has an active WeChat connection */
  isAnyWeChatConnected(): boolean {
    return this.pool.isAnyChannelConnected('wechat');
  }

  getFeishuConnection(userId: string): IMChannel | undefined {
    return this.pool.getUserChannel(userId, 'feishu');
  }

  getTelegramConnection(userId: string): IMChannel | undefined {
    return this.pool.getUserChannel(userId, 'telegram');
  }

  getQQConnection(userId: string): IMChannel | undefined {
    return this.pool.getUserChannel(userId, 'qq');
  }

  async getFeishuChatInfo(
    userId: string,
    chatId: string,
  ): Promise<{
    avatar?: string;
    name?: string;
    user_count?: string;
    chat_type?: string;
    chat_mode?: string;
  } | null> {
    const channel = this.getFeishuConnection(userId);
    if (!channel?.getChatInfo) return null;
    return channel.getChatInfo(chatId);
  }

  /**
   * Get chat info for an IM group by JID, auto-routing to the correct connection.
   * Used for health checks to detect disbanded groups.
   *
   * Returns:
   * - object: chat info (reachable)
   * - null: channel supports getChatInfo but chat is not reachable
   * - undefined: channel does not support getChatInfo (e.g. Telegram, QQ)
   */
  async getChatInfo(jid: string): Promise<
    | {
        avatar?: string;
        name?: string;
        user_count?: string;
        chat_type?: string;
        chat_mode?: string;
      }
    | null
    | undefined
  > {
    const channelType = getChannelType(jid);
    if (!channelType) return null;

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.getChatInfo) {
      return channel.getChatInfo(chatId);
    }
    // Channel doesn't implement getChatInfo — not a reachability failure
    return undefined;
  }

  /** Get all user IDs with active connections */
  getConnectedUserIds(): string[] {
    return this.pool.getConnectedUserIds();
  }

  /**
   * Disconnect all IM connections for all users.
   * Called during graceful shutdown.
   */
  async disconnectAll(): Promise<void> {
    await this.pool.disconnectAll();
  }
}

export const imManager = new IMConnectionManager();
export type {
  ConnectFeishuOptions,
  FeishuConnectConfig,
  QQConnectConfig,
  TelegramConnectConfig,
  WeChatConnectConfig,
} from './manager.types.js';

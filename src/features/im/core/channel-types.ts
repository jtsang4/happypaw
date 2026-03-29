import type { StreamingCardController } from '../channels/feishu/streaming-card/index.js';

export interface IMChannelConnectOpts {
  onReady: () => void;
  onNewChat: (chatJid: string, chatName: string) => void;
  onMessage?: (chatJid: string, text: string, senderName: string) => void;
  ignoreMessagesBefore?: number;
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
  shouldProcessGroupMessage?: (chatJid: string) => boolean;
  onCardInterrupt?: (chatJid: string) => void;
}

export interface IMChannel {
  readonly channelType: string;
  connect(opts: IMChannelConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendFile?(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendImage?(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  setTyping(chatId: string, isTyping: boolean): Promise<void>;
  clearAckReaction?(chatId: string): void;
  isConnected(): boolean;
  syncGroups?(): Promise<void>;
  createStreamingSession?(
    chatId: string,
    onCardCreated?: (messageId: string) => void,
  ): StreamingCardController | undefined;
  getChatInfo?(chatId: string): Promise<{
    avatar?: string;
    name?: string;
    user_count?: string;
    chat_type?: string;
    chat_mode?: string;
  } | null>;
}

export interface UserIMConnection {
  userId: string;
  channels: Map<string, IMChannel>;
}

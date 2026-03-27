import * as lark from '@larksuiteoapi/node-sdk';

export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
}

export interface ConnectOptions {
  onReady: () => void;
  /** 收到消息后调用，让调用方自动注册未知的飞书聊天 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /** 热重连时设置：丢弃 create_time 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
  /** 斜杠指令回调（如 /clear），返回回复文本或 null */
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  /** 根据 chatJid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话） */
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Bot 被添加到群聊时调用（自动注册群组） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用（自动解绑 IM 绑定） */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 群聊消息过滤：bot 未被 @mention 时调用，返回 true 则处理，false 则丢弃 */
  shouldProcessGroupMessage?: (chatJid: string) => boolean;
  /** 飞书流式卡片按钮中断回调 */
  onCardInterrupt?: (chatJid: string) => void;
}

export interface FeishuChatInfo {
  avatar?: string;
  name?: string;
  user_count?: string;
  chat_type?: string;
  chat_mode?: string; // 'p2p' | 'group'
}

export interface FeishuConnection {
  connect(opts: ConnectOptions): Promise<boolean>;
  stop(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendReaction(chatId: string, isTyping: boolean): Promise<void>;
  /** Clear the "OnIt" ack reaction for a chat (e.g. when streaming card handled the reply). */
  clearAckReaction(chatId: string): void;
  isConnected(): boolean;
  syncGroups(): Promise<void>;
  getChatInfo(chatId: string): Promise<FeishuChatInfo | null>;
  /** Get the underlying Lark SDK client (for streaming cards) */
  getLarkClient(): lark.Client | null;
  /** Get the last received message ID for a chat (for reply threading) */
  getLastMessageId(chatId: string): string | undefined;
}

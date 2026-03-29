export interface FeishuConnectConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
}

export interface TelegramConnectConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
}

export interface QQConnectConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
}

export interface WeChatConnectConfig {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  enabled?: boolean;
}

export interface ConnectFeishuOptions {
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
  shouldProcessGroupMessage?: (chatJid: string) => boolean;
  onCardInterrupt?: (chatJid: string) => void;
}

export interface ConnectTelegramOptions {
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  ignoreMessagesBefore?: number;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
}

export interface ConnectQQOptions {
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
}

export interface ConnectWeChatOptions {
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
}

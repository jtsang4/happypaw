export type { IMChannel, IMChannelConnectOpts } from './core/channel-types.js';
export {
  CHANNEL_REGISTRY,
  extractChatId,
  getChannelType,
} from './core/channel-routing.js';
export {
  createFeishuChannel,
  createQQChannel,
  createTelegramChannel,
  createWeChatChannel,
} from './core/channel-adapters.js';

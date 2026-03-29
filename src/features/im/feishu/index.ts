export { createFeishuConnection } from './connection.js';

export {
  connectFeishu,
  sendFeishuMessage,
  setFeishuTyping,
  syncFeishuGroups,
  isFeishuConnected,
  stopFeishu,
} from './legacy.js';

export type { ConnectFeishuOptions } from './legacy.js';

export type {
  ConnectOptions,
  FeishuChatInfo,
  FeishuConnection,
  FeishuConnectionConfig,
} from './types.js';

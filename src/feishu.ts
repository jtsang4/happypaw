export { createFeishuConnection } from './feishu/connection.js';

export {
  connectFeishu,
  sendFeishuMessage,
  setFeishuTyping,
  syncFeishuGroups,
  isFeishuConnected,
  stopFeishu,
} from './feishu/legacy.js';

export type { ConnectFeishuOptions } from './feishu/legacy.js';

export type {
  ConnectOptions,
  FeishuChatInfo,
  FeishuConnection,
  FeishuConnectionConfig,
} from './feishu/types.js';

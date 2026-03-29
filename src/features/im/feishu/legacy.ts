import { logger } from '../../../logger.js';
import { createFeishuConnection } from './connection.js';
import type { FeishuConnection } from './types.js';

// ─── Backward-compatible global singleton ──────────────────────
// @deprecated — 旧的顶层导出函数，内部使用一个默认全局实例。
// 后续由 imManager 替代。

let _defaultInstance: FeishuConnection | null = null;

export interface ConnectFeishuOptions {
  onReady: () => void;
  /** 收到消息后调用，让主模块自动注册未知的飞书聊天到主容器 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /** 热重连时设置：丢弃 create_time 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
}

/**
 * @deprecated Use createFeishuConnection() factory instead. Will be replaced by imManager.
 * Connect to Feishu via WebSocket and start receiving messages.
 */
export async function connectFeishu(
  opts: ConnectFeishuOptions,
): Promise<boolean> {
  const { getFeishuProviderConfigWithSource } =
    await import('../../../runtime-config.js');
  const { config, source } = getFeishuProviderConfigWithSource();
  if (!config.appId || !config.appSecret) {
    logger.warn(
      { source },
      'Feishu config is empty, running in Web-only mode (set it in Settings -> Feishu config)',
    );
    return false;
  }

  _defaultInstance = createFeishuConnection({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  return _defaultInstance.connect(opts);
}

/**
 * @deprecated Use FeishuConnection.sendMessage() instead.
 */
export async function sendFeishuMessage(
  chatId: string,
  text: string,
  localImagePaths?: string[],
): Promise<void> {
  if (!_defaultInstance) {
    logger.warn(
      { chatId },
      'Feishu client not initialized, skip sending message',
    );
    return;
  }
  return _defaultInstance.sendMessage(chatId, text, localImagePaths);
}

/**
 * @deprecated Use FeishuConnection.sendReaction() instead.
 */
export async function setFeishuTyping(
  chatId: string,
  isTyping: boolean,
): Promise<void> {
  if (!_defaultInstance) return;
  return _defaultInstance.sendReaction(chatId, isTyping);
}

/**
 * @deprecated Use FeishuConnection.syncGroups() instead.
 */
export async function syncFeishuGroups(): Promise<void> {
  if (!_defaultInstance) {
    logger.debug('Feishu client not initialized, skip group sync');
    return;
  }
  return _defaultInstance.syncGroups();
}

/**
 * @deprecated Use FeishuConnection.isConnected() instead.
 */
export function isFeishuConnected(): boolean {
  return _defaultInstance?.isConnected() ?? false;
}

/**
 * @deprecated Use FeishuConnection.stop() instead.
 */
export async function stopFeishu(): Promise<void> {
  if (_defaultInstance) {
    await _defaultInstance.stop();
    _defaultInstance = null;
  }
}

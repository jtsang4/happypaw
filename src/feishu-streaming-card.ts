export { StreamingCardController } from './feishu-streaming-card/controller.js';

export {
  registerMessageIdMapping,
  resolveJidByMessageId,
  unregisterMessageId,
  registerStreamingSession,
  unregisterStreamingSession,
  getStreamingSession,
  hasActiveStreamingSession,
  abortAllStreamingSessions,
} from './feishu-streaming-card/registry.js';

export type {
  AuxiliaryState,
  StreamingCardOptions,
} from './feishu-streaming-card/helpers.js';

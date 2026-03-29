import { logger } from './app/logger.js';
import { startRuntime } from './features/chat-runtime/runtime-composition.js';

startRuntime().catch((err) => {
  logger.error({ err }, 'Failed to start happypaw');
  process.exit(1);
});

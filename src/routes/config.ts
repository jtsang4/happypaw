// Configuration management routes

import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import { registerCodexRoutes } from './config/codex-routes.js';
import { registerLegacyAndSystemRoutes } from './config/legacy-system-routes.js';
import { injectConfigDeps } from './config/shared.js';
import { registerUserImRoutes } from './config/user-im-routes.js';
import { registerUserImWeChatAndBindingRoutes } from './config/user-im-wechat-bindings-routes.js';

const configRoutes = new Hono<{ Variables: Variables }>();

registerCodexRoutes(configRoutes);
registerLegacyAndSystemRoutes(configRoutes);
registerUserImRoutes(configRoutes);
registerUserImWeChatAndBindingRoutes(configRoutes);

export { injectConfigDeps };
export default configRoutes;

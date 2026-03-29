// Configuration management routes

import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import { registerCodexRoutes } from '../features/configuration/routes/config/codex-routes.js';
import { registerSystemRoutes } from '../features/configuration/routes/config/system-routes.js';
import { injectConfigDeps } from '../features/configuration/routes/config/shared.js';
import { registerUserImRoutes } from '../features/configuration/routes/config/user-im-routes.js';
import { registerUserImWeChatAndBindingRoutes } from '../features/configuration/routes/config/user-im-wechat-bindings-routes.js';

const configRoutes = new Hono<{ Variables: Variables }>();

registerCodexRoutes(configRoutes);
registerSystemRoutes(configRoutes);
registerUserImRoutes(configRoutes);
registerUserImWeChatAndBindingRoutes(configRoutes);

export { injectConfigDeps };
export default configRoutes;

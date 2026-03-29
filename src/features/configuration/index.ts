// Configuration management routes

import { Hono } from 'hono';

import type { Variables } from '../../app/web/context.js';
import { registerCodexRoutes } from './routes/config/codex-routes.js';
import { registerSystemRoutes } from './routes/config/system-routes.js';
import { injectConfigDeps } from './routes/config/shared.js';
import { registerUserImRoutes } from './routes/config/user-im-routes.js';
import { registerUserImWeChatAndBindingRoutes } from './routes/config/user-im-wechat-bindings-routes.js';

const configRoutes = new Hono<{ Variables: Variables }>();

registerCodexRoutes(configRoutes);
registerSystemRoutes(configRoutes);
registerUserImRoutes(configRoutes);
registerUserImWeChatAndBindingRoutes(configRoutes);

export { injectConfigDeps };
export default configRoutes;

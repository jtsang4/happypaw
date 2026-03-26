// Configuration management routes

import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import { registerLegacyAndSystemRoutes } from './config/legacy-system-routes.js';
import { registerProviderRoutes } from './config/provider-routes.js';
import { injectConfigDeps } from './config/shared.js';
import { registerUserImRoutes } from './config/user-im-routes.js';
import { registerUserImWeChatAndBindingRoutes } from './config/user-im-wechat-bindings-routes.js';

const configRoutes = new Hono<{ Variables: Variables }>();

registerProviderRoutes(configRoutes);
registerLegacyAndSystemRoutes(configRoutes);
registerUserImRoutes(configRoutes);
registerUserImWeChatAndBindingRoutes(configRoutes);

export { injectConfigDeps };
export default configRoutes;

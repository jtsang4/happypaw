import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import { TerminalManager } from './features/execution/terminal-manager.js';

// Web context and shared utilities
import {
  type WebDeps,
  type Variables,
  type WsClientInfo,
  setWebDeps,
  getWebDeps,
  wsClients,
  lastActiveCache,
  LAST_ACTIVE_DEBOUNCE_MS,
  parseCookie,
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
  getCachedSessionWithUser,
  invalidateSessionCache,
} from './app/web/context.js';

// Schemas
import {
  MessageCreateSchema,
  TerminalStartSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalStopSchema,
} from './app/web/schemas.js';
import { createMessageIngress } from './app/web/message-ingress.js';
import {
  broadcastAgentStatus,
  broadcastBillingUpdate,
  broadcastDockerBuildComplete,
  broadcastDockerBuildLog,
  broadcastNewMessage,
  broadcastRunnerState,
  broadcastStatusUpdate,
  broadcastStreamEvent,
  broadcastToWebClients,
  broadcastTyping,
  clearStreamingSnapshot,
  getAccessibleBroadcastJid,
  getActiveStreamingTexts,
  getStreamingSnapshotsForUser,
  invalidateAllowedUserCache,
} from './app/web/broadcast.js';

// Middleware
import { authMiddleware } from './middleware/auth.js';

// Route modules
import authRoutes from './features/auth/routes/auth.js';
import groupRoutes from './features/groups/routes/groups.js';
import memoryRoutes from './features/memory/routes/memory.js';
import configRoutes, {
  injectConfigDeps,
} from './features/configuration/index.js';
import tasksRoutes from './features/tasks/routes/tasks.js';
import adminRoutes from './features/auth/routes/admin.js';
import fileRoutes from './features/groups/routes/files.js';
import monitorRoutes, {
  injectMonitorDeps,
} from './features/monitoring/routes/monitor.js';
import skillsRoutes from './features/skills/routes/skills.js';
import browseRoutes from './features/groups/routes/browse.js';
import agentRoutes from './features/agents/routes/agents.js';
import mcpServersRoutes from './features/mcp/routes/mcp-servers.js';
import workspaceConfigRoutes from './features/groups/routes/workspace-config.js';
import agentDefinitionsRoutes from './features/agents/routes/agent-definitions.js';
import { usage as usageRoutes } from './features/monitoring/routes/usage.js';
import billingRoutes from './features/billing/routes/billing.js';
import bugReportRoutes from './features/monitoring/routes/bug-report.js';
import {
  getRegisteredGroup,
  ensureChatExists,
  storeMessageDirect,
  deleteUserSession,
  updateSessionLastActive,
} from './db.js';
import { isSessionExpired } from './features/auth/auth.js';
import type {
  WsMessageOut,
  WsMessageIn,
  AuthUser,
  UserRole,
} from './shared/types.js';
import {
  WEB_PORT,
  SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
} from './app/config.js';
import { logger } from './app/logger.js';
import { executeSessionReset } from './features/chat-runtime/commands.js';

// --- App Setup ---

const app = new Hono<{ Variables: Variables }>();
const terminalManager = new TerminalManager();
const wsTerminals = new Map<WebSocket, string>(); // ws → groupJid
const terminalOwners = new Map<string, WebSocket>(); // groupJid → ws

function normalizeTerminalSize(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const intValue = Math.floor(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function releaseTerminalOwnership(ws: WebSocket, groupJid: string): void {
  if (wsTerminals.get(ws) === groupJid) {
    wsTerminals.delete(ws);
  }
  if (terminalOwners.get(groupJid) === ws) {
    terminalOwners.delete(groupJid);
  }
}

// --- CORS Middleware ---
const CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || '';
const CORS_ALLOW_LOCALHOST = process.env.CORS_ALLOW_LOCALHOST !== 'false'; // default: true

function isAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null; // same-origin requests
  // 环境变量设为 '*' 时允许所有来源
  if (CORS_ALLOWED_ORIGINS === '*') return origin;
  // 允许 localhost / 127.0.0.1 的任意端口（开发 & 自托管场景，可通过 CORS_ALLOW_LOCALHOST=false 关闭）
  if (CORS_ALLOW_LOCALHOST) {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
        return origin;
    } catch {
      /* invalid origin */
    }
  }
  // 自定义白名单（逗号分隔）
  if (CORS_ALLOWED_ORIGINS) {
    const allowed = CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    if (allowed.includes(origin)) return origin;
  }
  return null;
}

app.use(
  '/api/*',
  cors({
    origin: (origin) => isAllowedOrigin(origin),
    credentials: true,
  }),
);

// --- Global State ---

let deps: WebDeps | null = null;

// --- Route Mounting ---

app.route('/api/auth', authRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/groups', fileRoutes); // File routes also under /api/groups
app.route('/api/memory', memoryRoutes);
app.route('/api/config', configRoutes);
app.route('/api/tasks', tasksRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/browse', browseRoutes);
app.route('/api/mcp-servers', mcpServersRoutes);
app.route('/api/agent-definitions', agentDefinitionsRoutes);
app.route('/api/groups', agentRoutes); // Agent routes under /api/groups/:jid/agents
app.route('/api/groups', workspaceConfigRoutes); // Workspace config under /api/groups/:jid/workspace-config
app.route('/api', monitorRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/bug-report', bugReportRoutes);

// --- POST /api/messages ---

app.post('/api/messages', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const validation = MessageCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const { chatJid, content, attachments } = validation.data;
  const group = getRegisteredGroup(chatJid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup(authUser, group)) {
    return c.json({ error: 'Access denied' }, 403);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  const result = await handleWebUserMessage(
    chatJid,
    content.trim(),
    attachments,
    authUser.id,
    authUser.display_name || authUser.username,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    success: true,
    messageId: result.messageId,
    timestamp: result.timestamp,
  });
});

const { handleWebUserMessage, handleAgentConversationMessage } =
  createMessageIngress({
    getWebDeps: () => deps,
    broadcastNewMessage,
  });

// --- Static Files ---

// 带 content hash 的静态资源：长期不可变缓存
app.use(
  '/assets/*',
  async (c, next) => {
    await next();
    if (c.res.status === 200) {
      c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
  serveStatic({ root: './web/dist' }),
);

// SPA fallback：index.html / sw.js 等必须每次验证
app.use(
  '/*',
  async (c, next) => {
    await next();
    if (c.res.status === 200) {
      const p = c.req.path;
      // 非文件扩展名路径（SPA fallback → index.html）、SW 脚本、manifest 禁止缓存
      if (
        !p.match(/\.\w+$/) ||
        p === '/sw.js' ||
        p === '/registerSW.js' ||
        p === '/manifest.webmanifest'
      ) {
        c.res.headers.set(
          'Cache-Control',
          'no-cache, no-store, must-revalidate',
        );
      }
    }
  },
  serveStatic({
    root: './web/dist',
    rewriteRequestPath: (p) => {
      // SPA fallback
      if (p.startsWith('/api') || p.startsWith('/ws')) return p;
      if (p.match(/\.\w+$/)) return p; // Has file extension
      return '/index.html';
    },
  }),
);

// --- WebSocket ---

function setupWebSocket(server: any): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: any, socket: any, head: any) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Verify session cookie
    const cookies = parseCookie(request.headers.cookie);
    const token =
      cookies[SESSION_COOKIE_NAME_SECURE] || cookies[SESSION_COOKIE_NAME_PLAIN];
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const session = getCachedSessionWithUser(token);
    if (!session) {
      invalidateSessionCache(token);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (isSessionExpired(session.expires_at)) {
      deleteUserSession(token);
      invalidateSessionCache(token);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (session.status !== 'active') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    request.__happypawSessionId = token;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request: any) => {
    const sessionId = request?.__happypawSessionId as string | undefined;
    logger.info('WebSocket client connected');
    const connSession = sessionId
      ? getCachedSessionWithUser(sessionId)
      : undefined;
    wsClients.set(ws, {
      sessionId: sessionId || '',
      userId: connSession?.user_id || '',
      role: (connSession?.role || 'member') as UserRole,
    });

    // Push streaming snapshots for active groups this user can access
    if (connSession) {
      for (const snapshot of getStreamingSnapshotsForUser(
        connSession.user_id,
      )) {
        try {
          ws.send(
            JSON.stringify({
              type: 'stream_snapshot',
              chatJid: snapshot.chatJid,
              snapshot: snapshot.snapshot,
            } satisfies WsMessageOut),
          );
        } catch {
          /* client not ready */
        }
      }
    }

    // Push runner_state: 'running' for all active groups on WS connect.
    // This prevents a race where a late-arriving new_message clears
    // waiting=false after snapshot restore, blocking all subsequent
    // stream events. The runner_state event resets waiting=true.
    if (connSession && deps) {
      const userId = connSession.user_id;
      const queueStatus = deps.queue.getStatus();
      for (const g of queueStatus.groups) {
        if (!g.active) continue;
        const jid = getAccessibleBroadcastJid(g.jid, userId);
        if (!jid) continue;
        try {
          ws.send(
            JSON.stringify({
              type: 'runner_state',
              chatJid: jid,
              state: 'running',
            } satisfies WsMessageOut),
          );
        } catch {
          /* client not ready */
        }
      }
    }

    const cleanupTerminalForWs = () => {
      const termJid = wsTerminals.get(ws);
      if (!termJid) return;
      terminalManager.stop(termJid);
      releaseTerminalOwnership(ws, termJid);
    };

    ws.on('message', async (data) => {
      if (!deps) return;

      try {
        if (!sessionId) {
          ws.close(1008, 'Unauthorized');
          return;
        }

        const session = getCachedSessionWithUser(sessionId);
        if (
          !session ||
          isSessionExpired(session.expires_at) ||
          session.status !== 'active'
        ) {
          if (session && isSessionExpired(session.expires_at)) {
            deleteUserSession(sessionId);
          }
          invalidateSessionCache(sessionId);
          ws.close(1008, 'Unauthorized');
          return;
        }

        const now = Date.now();
        const lastUpdate = lastActiveCache.get(sessionId) || 0;
        if (now - lastUpdate > LAST_ACTIVE_DEBOUNCE_MS) {
          lastActiveCache.set(sessionId, now);
          try {
            updateSessionLastActive(sessionId);
          } catch {
            /* best effort */
          }
        }

        const msg: WsMessageIn = JSON.parse(data.toString());

        const sendWsError = (error: string, chatJid?: string) => {
          const msg: WsMessageOut = { type: 'ws_error', error, chatJid };
          ws.send(JSON.stringify(msg));
        };

        if (msg.type === 'send_message') {
          const wsValidation = MessageCreateSchema.safeParse({
            chatJid: msg.chatJid,
            content: msg.content,
            attachments: msg.attachments,
          });
          if (!wsValidation.success) {
            sendWsError('消息格式无效', msg.chatJid);
            logger.warn(
              {
                chatJid: msg.chatJid,
                issues: wsValidation.error.issues.map((i) => i.message),
              },
              'WebSocket send_message validation failed',
            );
            return;
          }
          const { chatJid, content, attachments } = wsValidation.data;
          const agentId = (msg as { agentId?: string }).agentId;

          // 群组访问权限检查
          const targetGroup = getRegisteredGroup(chatJid);
          if (targetGroup) {
            if (
              !canAccessGroup(
                { id: session.user_id, role: session.role },
                targetGroup,
              )
            ) {
              sendWsError('无权访问该群组', chatJid);
              logger.warn(
                { chatJid, userId: session.user_id },
                'WebSocket send_message blocked: access denied',
              );
              return;
            }
            if (isHostExecutionGroup(targetGroup)) {
              if (session.role !== 'admin') {
                sendWsError('宿主机模式需要管理员权限', chatJid);
                logger.warn(
                  { chatJid, userId: session.user_id },
                  'WebSocket send_message blocked: host mode requires admin',
                );
                return;
              }
            }
          }

          // ── /sw or /spawn command: spawn parallel task (checked before agent routing) ──
          const swMatch = content.trim().match(/^\/(sw|spawn)\s+([\s\S]+)$/i);
          if (swMatch && deps?.handleSpawnCommand) {
            const spawnMessage = swMatch[2].trim();
            if (spawnMessage) {
              try {
                // For agent tab, include agentId in chatJid so spawn resolves the right workspace
                const effectiveChatJid = agentId
                  ? `${chatJid}#agent:${agentId}`
                  : chatJid;
                // Store user's /sw message in the current chat so it's visible
                const userMsgId = crypto.randomUUID();
                const userMsgTs = new Date().toISOString();
                ensureChatExists(effectiveChatJid);
                storeMessageDirect(
                  userMsgId,
                  effectiveChatJid,
                  session.user_id,
                  session.display_name || session.username,
                  content.trim(),
                  userMsgTs,
                  false,
                  { meta: { sourceKind: 'user_command' } },
                );
                broadcastNewMessage(effectiveChatJid, {
                  id: userMsgId,
                  chat_jid: effectiveChatJid,
                  sender: session.user_id,
                  sender_name: session.display_name || session.username,
                  content: content.trim(),
                  timestamp: userMsgTs,
                  is_from_me: false,
                });

                await deps.handleSpawnCommand(effectiveChatJid, spawnMessage);
              } catch (err) {
                logger.error({ chatJid, err }, '/sw command failed');
              }
            }
            return;
          }

          // Route to agent conversation handler if agentId is present
          if (agentId && deps) {
            await handleAgentConversationMessage(
              chatJid,
              agentId,
              content.trim(),
              session.user_id,
              session.display_name || session.username,
              attachments,
            );
            return;
          }

          // ── /clear command: reset session without entering message pipeline ──
          if (content.trim().toLowerCase() === '/clear' && deps) {
            const targetGroup = getRegisteredGroup(chatJid);
            if (targetGroup) {
              try {
                await executeSessionReset(chatJid, targetGroup.folder, {
                  queue: deps.queue,
                  sessions: deps.getSessions(),
                  broadcast: broadcastNewMessage,
                  setLastAgentTimestamp: deps.setLastAgentTimestamp,
                });
              } catch (err) {
                logger.error({ chatJid, err }, '/clear command failed');
                const errId = crypto.randomUUID();
                const errTs = new Date().toISOString();
                ensureChatExists(chatJid);
                storeMessageDirect(
                  errId,
                  chatJid,
                  '__system__',
                  'system',
                  'system_error:清除上下文失败，请稍后重试',
                  errTs,
                  true,
                );
                broadcastNewMessage(chatJid, {
                  id: errId,
                  chat_jid: chatJid,
                  sender: '__system__',
                  sender_name: 'system',
                  content: 'system_error:清除上下文失败，请稍后重试',
                  timestamp: errTs,
                  is_from_me: true,
                });
              }
            }
            return;
          }

          const result = await handleWebUserMessage(
            chatJid,
            content.trim(),
            attachments,
            session.user_id,
            session.display_name || session.username,
          );
          if (!result.ok) {
            logger.warn(
              { chatJid, status: result.status, error: result.error },
              'WebSocket message rejected',
            );
          }
        } else if (msg.type === 'terminal_start') {
          try {
            // Schema 验证
            const startValidation = TerminalStartSchema.safeParse(msg);
            if (!startValidation.success) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid: msg.chatJid || '',
                  error: '终端启动参数无效',
                }),
              );
              return;
            }
            const chatJid = startValidation.data.chatJid.trim();
            if (!chatJid) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid: '',
                  error: 'chatJid 无效',
                }),
              );
              return;
            }
            const group = deps.getRegisteredGroups()[chatJid];
            if (!group) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '群组不存在',
                }),
              );
              return;
            }
            // Permission: user must be able to access the group
            const groupWithJid = { ...group, jid: chatJid };
            if (
              !canAccessGroup(
                { id: session.user_id, role: session.role },
                groupWithJid,
              )
            ) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '无权访问该群组终端',
                }),
              );
              return;
            }
            if ((group.executionMode || 'container') === 'host') {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '宿主机模式不支持终端',
                }),
              );
              return;
            }
            // 查找活跃的容器
            const status = deps.queue.getStatus();
            const groupStatus = status.groups.find((g) => g.jid === chatJid);
            if (!groupStatus || !groupStatus.active) {
              deps.ensureTerminalContainerStarted(chatJid);
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '工作区启动中，请稍后重试',
                }),
              );
              return;
            }
            if (!groupStatus.containerName) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '工作区启动中，请稍后重试',
                }),
              );
              return;
            }
            const cols = normalizeTerminalSize(msg.cols, 80, 20, 300);
            const rows = normalizeTerminalSize(msg.rows, 24, 8, 120);
            // 停止该 ws 之前的终端
            const prevJid = wsTerminals.get(ws);
            if (prevJid && prevJid !== chatJid) {
              terminalManager.stop(prevJid);
              releaseTerminalOwnership(ws, prevJid);
            }

            // 若该 group 已被其它 ws 占用，先释放旧 owner，防止后续 close 误杀新会话
            const existingOwner = terminalOwners.get(chatJid);
            if (existingOwner && existingOwner !== ws) {
              terminalManager.stop(chatJid);
              releaseTerminalOwnership(existingOwner, chatJid);
              if (existingOwner.readyState === WebSocket.OPEN) {
                existingOwner.send(
                  JSON.stringify({
                    type: 'terminal_stopped',
                    chatJid,
                    reason: '终端被其他连接接管',
                  }),
                );
              }
            }

            terminalManager.start(
              chatJid,
              groupStatus.containerName,
              cols,
              rows,
              (data) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({ type: 'terminal_output', chatJid, data }),
                  );
                }
              },
              (_exitCode, _signal) => {
                if (terminalOwners.get(chatJid) === ws) {
                  releaseTerminalOwnership(ws, chatJid);
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'terminal_stopped',
                      chatJid,
                      reason: '终端进程已退出',
                    }),
                  );
                }
              },
            );
            wsTerminals.set(ws, chatJid);
            terminalOwners.set(chatJid, ws);
            ws.send(JSON.stringify({ type: 'terminal_started', chatJid }));
          } catch (err) {
            logger.error(
              { err, chatJid: msg.chatJid },
              'Error starting terminal',
            );
            const detail =
              err instanceof Error && err.message
                ? err.message.slice(0, 160)
                : 'unknown';
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: msg.chatJid,
                error: `启动终端失败 (${detail})`,
              }),
            );
          }
        } else if (msg.type === 'terminal_input') {
          const inputValidation = TerminalInputSchema.safeParse(msg);
          if (!inputValidation.success) {
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: msg.chatJid || '',
                error: '终端输入参数无效',
              }),
            );
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (
            ownerJid !== inputValidation.data.chatJid ||
            terminalOwners.get(inputValidation.data.chatJid) !== ws
          ) {
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: inputValidation.data.chatJid,
                error: '终端会话已失效',
              }),
            );
            return;
          }
          terminalManager.write(
            inputValidation.data.chatJid,
            inputValidation.data.data,
          );
        } else if (msg.type === 'terminal_resize') {
          const resizeValidation = TerminalResizeSchema.safeParse(msg);
          if (!resizeValidation.success) {
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: msg.chatJid || '',
                error: '终端调整参数无效',
              }),
            );
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (
            ownerJid !== resizeValidation.data.chatJid ||
            terminalOwners.get(resizeValidation.data.chatJid) !== ws
          ) {
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: resizeValidation.data.chatJid,
                error: '终端会话已失效',
              }),
            );
            return;
          }
          const cols = normalizeTerminalSize(
            resizeValidation.data.cols,
            80,
            20,
            300,
          );
          const rows = normalizeTerminalSize(
            resizeValidation.data.rows,
            24,
            8,
            120,
          );
          terminalManager.resize(resizeValidation.data.chatJid, cols, rows);
        } else if (msg.type === 'terminal_stop') {
          const stopValidation = TerminalStopSchema.safeParse(msg);
          if (!stopValidation.success) {
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (
            ownerJid !== stopValidation.data.chatJid ||
            terminalOwners.get(stopValidation.data.chatJid) !== ws
          ) {
            return;
          }
          terminalManager.stop(stopValidation.data.chatJid);
          releaseTerminalOwnership(ws, stopValidation.data.chatJid);
          ws.send(
            JSON.stringify({
              type: 'terminal_stopped',
              chatJid: stopValidation.data.chatJid,
              reason: '用户关闭终端',
            }),
          );
        }
      } catch (err) {
        logger.error({ err }, 'Error handling WebSocket message');
      }
    });

    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
      wsClients.delete(ws);
      cleanupTerminalForWs();
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
      wsClients.delete(ws);
      cleanupTerminalForWs();
    });
  });

  return wss;
}
function broadcastStatus(): void {
  if (!deps) return;

  const queueStatus = deps.queue.getStatus();
  broadcastStatusUpdate({
    activeContainers: queueStatus.activeContainerCount,
    activeHostProcesses: queueStatus.activeHostProcessCount,
    activeTotal: queueStatus.activeCount,
    queueLength: queueStatus.waitingCount,
  });
}

// --- Server Startup ---

let statusInterval: ReturnType<typeof setInterval> | null = null;
let httpServer: ReturnType<typeof serve> | null = null;
let wss: WebSocketServer | null = null;

export function startWebServer(webDeps: WebDeps): void {
  deps = webDeps;
  setWebDeps(webDeps);
  injectConfigDeps(webDeps);
  injectMonitorDeps({
    broadcastDockerBuildLog,
    broadcastDockerBuildComplete,
  });

  httpServer = serve(
    {
      fetch: app.fetch,
      port: WEB_PORT,
    },
    (info) => {
      logger.info({ port: info.port }, 'Web server started');
    },
  );

  wss = setupWebSocket(httpServer);

  // Register container exit callback for terminal cleanup
  webDeps.queue.setOnContainerExit((groupJid: string) => {
    if (terminalManager.has(groupJid)) {
      const ownerWs = terminalOwners.get(groupJid);
      terminalManager.stop(groupJid);
      if (ownerWs) {
        releaseTerminalOwnership(ownerWs, groupJid);
        if (ownerWs.readyState === WebSocket.OPEN) {
          ownerWs.send(
            JSON.stringify({
              type: 'terminal_stopped',
              chatJid: groupJid,
              reason: '工作区已停止',
            }),
          );
        }
      }
    }
  });

  // Register runner state change callback for sidebar indicators
  webDeps.queue.setOnRunnerStateChange(broadcastRunnerState);

  // Broadcast status every 5 seconds
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(broadcastStatus, 5000);
}

// --- Exports ---

export function shutdownTerminals(): void {
  terminalManager.shutdown();
}

export async function shutdownWebServer(): Promise<void> {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  // Close all WebSocket connections
  for (const client of wsClients.keys()) {
    try {
      client.close(1001, 'Server shutting down');
    } catch {
      /* ignore */
    }
  }
  wsClients.clear();
  // Close WebSocket server
  if (wss) {
    wss.close();
    wss = null;
  }
  // Close HTTP server
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

export {
  broadcastAgentStatus,
  broadcastBillingUpdate,
  broadcastNewMessage,
  broadcastRunnerState,
  broadcastStreamEvent,
  broadcastToWebClients,
  broadcastTyping,
  clearStreamingSnapshot,
  getActiveStreamingTexts,
  invalidateAllowedUserCache,
};

export type { WebDeps } from './app/web/context.js';

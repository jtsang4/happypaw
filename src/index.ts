import { ChildProcess, execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TIMEZONE,
  isDockerAvailable,
  updateWeChatNoProxy,
} from './config.js';
import { LEGACY_AGENT_SENDER, toLegacyProductToken } from './legacy-product.js';
import { interruptibleSleep } from './message-notifier.js';
import {
  AvailableGroup,
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  closeDatabase,
  createTask,
  deleteExpiredSessions,
  getExpiredSessionIds,
  deleteTask,
  ensureChatExists,
  ensureUserHomeGroup,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  hasContainerModeGroups,
  getAllTasks,
  getJidsByFolder,
  getLastGroupSync,
  getRegisteredGroup,
  getUserById,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getRouterStateByPrefix,
  deleteRouterState,
  getTaskById,
  getUserHomeGroup,
  initDatabase,
  isGroupShared,
  listUsers,
  setLastGroupSync,
  setRegisteredGroup,
  setRouterState,
  setSession,
  deleteSession,
  storeMessageDirect,
  updateLatestMessageTokenUsage,
  updateChatName,
  updateTask,
  createAgent,
  getAgent,
  updateAgentStatus,
  updateAgentLastImJid,
  updateAgentInfo,
  deleteCompletedAgents,
  getRunningTaskAgentsByChat,
  markRunningTaskAgentsAsError,
  markAllRunningTaskAgentsAsError,
  markStaleSpawnAgentsAsError,
  listActiveConversationAgents,
  getSession,
  getRuntimeSession,
  listAgentsByJid,
  getGroupsByOwner,
  getMessagesPage,
  addGroupMember,
  cleanupOldDailyUsage,
  cleanupOldBillingAuditLog,
  insertUsageRecord,
} from './db.js';
// feishu.js deprecated exports are no longer needed; imManager handles all connections
import { imManager } from './im-manager.js';
import { getChannelType, extractChatId } from './im-channel.js';
import {
  registerStreamingSession,
  unregisterStreamingSession,
  hasActiveStreamingSession,
  abortAllStreamingSessions,
  registerMessageIdMapping,
  getStreamingSession,
  StreamingCardController,
} from './feishu-streaming-card.js';
import {
  formatContextMessages,
  formatWorkspaceList,
  formatSystemStatus,
  resolveLocationInfo,
  type WorkspaceInfo,
} from './im-command-utils.js';
import { invalidateSessionCache, getWebDeps } from './web-context.js';
import {
  getFeishuProviderConfigWithSource,
  getTelegramProviderConfig,
  getTelegramProviderConfigWithSource,
  getSystemSettings,
  getUserFeishuConfig,
  getUserTelegramConfig,
  getUserQQConfig,
  getUserWeChatConfig,
  saveUserFeishuConfig,
  saveUserTelegramConfig,
  updateAllSessionCredentials,
} from './runtime-config.js';
import type {
  FeishuConnectConfig,
  TelegramConnectConfig,
  QQConnectConfig,
  WeChatConnectConfig,
} from './im-manager.js';
import { GroupQueue } from './group-queue.js';
import { startSchedulerLoop, triggerTaskNow } from './task-scheduler.js';
import {
  checkBillingAccessFresh,
  formatBillingAccessDeniedMessage,
  updateUsage,
  deductUsageCost,
  checkAndExpireSubscriptions,
  isBillingEnabled,
  getUserConcurrentContainerLimit,
  reconcileMonthlyUsage,
} from './billing.js';
import {
  AgentStatus,
  MessageCursor,
  NewMessage,
  RegisteredGroup,
  RuntimeSessionRecord,
  RuntimeType,
  StreamEvent,
  SubAgent,
} from './types.js';
import { logger } from './logger.js';
import {
  ensureAgentDirectories,
  isSystemMaintenanceNoise,
  stripAgentInternalTags,
  stripVirtualJidSuffix,
} from './utils.js';
import { normalizeImageAttachments } from './message-attachments.js';
import {
  startWebServer,
  broadcastToWebClients,
  broadcastNewMessage,
  broadcastTyping,
  broadcastStreamEvent,
  broadcastAgentStatus,
  broadcastBillingUpdate,
  shutdownTerminals,
  shutdownWebServer,
  getActiveStreamingTexts,
  clearStreamingSnapshot,
} from './web.js';
import {
  installSkillForUser,
  deleteSkillForUser,
  syncHostSkillsForUser,
} from './routes/skills.js';
import {
  clearPersistedRuntimeStateForRecovery,
  clearSessionRuntimeFiles,
} from './runtime-state-cleanup.js';
import {
  EMPTY_CURSOR,
  buildInterruptedReply,
  buildOverflowPartialReply,
  createCursorStateHelpers,
  createStreamingBufferManager,
  isCursorAfter,
  normalizeCursor,
  recoverConversationAgents as recoverConversationAgentsHelper,
  recoverPendingMessages as recoverPendingMessagesHelper,
  recoverStuckPendingGroups as recoverStuckPendingGroupsHelper,
} from './index-recovery.js';
import { createSlashCommandHandlers } from './index-slash-commands.js';
import {
  IM_HEALTH_CHECK_FAIL_THRESHOLD,
  createImRoutingHelpers,
  type ReplyRouteUpdater,
} from './index-im-routing.js';
import { createMessageLoop } from './index-message-loop.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const execFileAsync = promisify(execFile);
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;
const OOM_EXIT_RE = /code 137/;

/**
 * Feed a stream event into a Feishu streaming card controller.
 * Centralizes the event → card mapping for both main and sub-agent handlers.
 */
function feedStreamEventToCard(
  session: StreamingCardController,
  se: StreamEvent,
  accumulatedText: string,
): void {
  switch (se.eventType) {
    case 'text_delta':
      if (se.text) session.append(accumulatedText);
      break;
    case 'thinking_delta':
      if (se.text) {
        session.appendThinking(se.text);
      } else if (!accumulatedText) {
        // Only call setThinking() when no text was appended
        // (appendThinking already sets thinking=true and triggers card creation)
        session.setThinking();
      }
      break;
    case 'tool_use_start':
      if (se.toolUseId && se.toolName) {
        session.startTool(se.toolUseId, se.toolName);
        const label = se.skillName ? `技能 ${se.skillName}` : se.toolName;
        session.pushRecentEvent(`🔄 ${label}`);
      }
      break;
    case 'tool_use_end':
      if (se.toolUseId) {
        const info = session.getToolInfo(se.toolUseId);
        session.endTool(se.toolUseId, false);
        if (info) session.pushRecentEvent(`✅ ${info.name}`);
      }
      break;
    case 'tool_progress':
      if (se.toolUseId && se.toolInputSummary) {
        session.updateToolSummary(se.toolUseId, se.toolInputSummary);
      }
      break;
    case 'status':
      if (se.statusText && se.statusText !== 'interrupted') {
        session.setSystemStatus(se.statusText);
      }
      break;
    case 'hook_started':
      session.setHook({
        hookName: se.hookName || '',
        hookEvent: se.hookEvent || '',
      });
      break;
    case 'hook_response':
      if (se.hookName) {
        session.pushRecentEvent(`✅ Hook: ${se.hookName}`);
      }
      session.setHook(null);
      break;
    case 'todo_update':
      if (se.todos) session.setTodos(se.todos);
      break;
    case 'task_start':
      if (se.toolUseId) {
        const label = se.taskDescription
          ? `Task: ${se.taskDescription.slice(0, 40)}`
          : 'Task';
        session.startTool(se.toolUseId, label);
        session.pushRecentEvent(`🚀 ${label}`);
      }
      break;
    case 'task_notification':
      if (se.toolUseId || se.taskId) {
        const id = se.toolUseId || se.taskId || '';
        session.endTool(id, false);
        const label = se.taskSummary
          ? `Task: ${se.taskSummary.slice(0, 40)}`
          : 'Task 完成';
        session.pushRecentEvent(`✅ ${label}`);
      }
      break;
    case 'hook_progress':
      // Update hook state (no card push needed — card already shows hook indicator)
      session.setHook({
        hookName: se.hookName || '',
        hookEvent: se.hookEvent || '',
      });
      break;
    case 'usage':
      if (se.usage) session.patchUsageNote(se.usage);
      break;
    case 'init':
      // Internal signal, no card display needed
      break;
  }
}

let globalMessageCursor: MessageCursor = { timestamp: '', id: '' };
let sessions: Record<string, RuntimeSessionRecord> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, MessageCursor> = {};
// Recovery-safe cursor: only advances when an agent actually finishes processing.
// recoverPendingMessages() uses this to detect IPC-injected but unprocessed messages.
let lastCommittedCursor: Record<string, MessageCursor> = {};
let ipcWatcherRunning = false;
let shuttingDown = false;

// ── IPC Watcher Manager (event-driven fs.watch + fallback polling) ──

class IpcWatcherManager {
  private watchers = new Map<
    string,
    { watchers: fs.FSWatcher[]; refCount: number }
  >();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processingFolders = new Set<string>();
  private pendingReprocess = new Set<string>();
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private processGroupFn: ((folder: string) => Promise<void>) | null = null;
  private processFullFn: (() => Promise<void>) | null = null;

  /** Bind the per-group and full-scan processing functions (set once from startIpcWatcher). */
  bind(
    processGroup: (folder: string) => Promise<void>,
    processFull: () => Promise<void>,
  ): void {
    this.processGroupFn = processGroup;
    this.processFullFn = processFull;
  }

  /** Start watching a group's IPC directories. Called when a container/process starts. */
  watchGroup(folder: string): void {
    const existing = this.watchers.get(folder);
    if (existing) {
      existing.refCount++;
      return;
    }

    const groupIpcRoot = path.join(DATA_DIR, 'ipc', folder);
    const dirsToWatch = [
      path.join(groupIpcRoot, 'messages'),
      path.join(groupIpcRoot, 'tasks'),
    ];

    const folderWatchers: fs.FSWatcher[] = [];
    for (const dir of dirsToWatch) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Listen to all event types — 'rename' covers atomic writes on Linux,
        // but Docker bind mounts (macOS virtiofs) may emit 'change' instead.
        const w = fs.watch(dir, () => {
          this.debouncedProcess(folder);
        });
        w.on('error', () => {
          // Watcher error — fallback polling will handle it
        });
        folderWatchers.push(w);
      } catch {
        // Watch failed — fallback polling will handle it
      }
    }
    this.watchers.set(folder, { watchers: folderWatchers, refCount: 1 });
  }

  /** Stop watching a group's IPC directories. Called when a container/process stops. */
  unwatchGroup(folder: string): void {
    const entry = this.watchers.get(folder);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;

    for (const w of entry.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers.delete(folder);
    const timer = this.debounceTimers.get(folder);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(folder);
    }
  }

  private debouncedProcess(folder: string): void {
    const existing = this.debounceTimers.get(folder);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      folder,
      setTimeout(() => {
        this.debounceTimers.delete(folder);
        // Skip if a previous processGroupIpc call for this folder is still running;
        // the pending flag ensures we re-process after the current run finishes.
        if (this.processingFolders.has(folder)) {
          this.pendingReprocess.add(folder);
          return;
        }
        this.processingFolders.add(folder);
        this.processGroupFn?.(folder)
          .catch((err) => {
            logger.error({ err, folder }, 'Error processing IPC for group');
          })
          .finally(() => {
            this.processingFolders.delete(folder);
            // Files may have arrived during processing — run once more
            if (
              this.pendingReprocess.delete(folder) &&
              this.watchers.has(folder)
            ) {
              this.debouncedProcess(folder);
            }
          });
      }, 100),
    );
  }

  /** Trigger processing for a folder through the concurrency guard. */
  triggerProcess(folder: string): void {
    this.debouncedProcess(folder);
  }

  /** Start fallback polling (every 5s) as safety net for inotify failures. */
  startFallback(): void {
    this.fallbackTimer = setInterval(() => {
      if (shuttingDown) return;
      this.processFullFn?.().catch((err) => {
        logger.error({ err }, 'Error in IPC fallback scan');
      });
    }, 5000);
    this.fallbackTimer.unref(); // Don't prevent process from naturally exiting
  }

  /** Close all watchers and timers. */
  closeAll(): void {
    for (const [, entry] of this.watchers) {
      for (const w of entry.watchers) {
        try {
          w.close();
        } catch {}
      }
    }
    this.watchers.clear();
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}

let ipcWatcherManager: IpcWatcherManager | null = null;
/** JIDs already persisted by the shutdown handler — prevents finally blocks from duplicating. */
const shutdownSavedJids = new Set<string>();

const queue = new GroupQueue();
const terminalWarmupInFlight = new Set<string>();
const STUCK_RUNNER_CHECK_INTERVAL_POLLS = 15;
const STUCK_RUNNER_IDLE_MS = 6 * 60 * 1000;
let stuckRunnerCheckCounter = 0;

// OOM auto-recovery: track consecutive OOM (exit code 137) exits per folder.
// After OOM_AUTO_RESET_THRESHOLD consecutive OOMs, auto-clear the session.
const consecutiveOomExits: Record<string, number> = {};
const OOM_AUTO_RESET_THRESHOLD = 2;

// Per-folder reply route updater: lets sendMessage callers update the
// reply routing of a running processGroupMessages without killing the process.
// Key is group folder (one active processGroupMessages per folder).
const activeRouteUpdaters = new Map<string, ReplyRouteUpdater>();

// Per-folder IM reply route: tracks the current replySourceImJid for each
// running processGroupMessages.  IPC watcher reads this to forward send_message
// outputs to the correct IM channel (the running session holds the truth).
const activeImReplyRoutes = new Map<string, string | null>();

// Track consecutive IM send failures per JID for auto-unbind
const imSendFailCounts = new Map<string, number>();

// Groups whose pending messages were recovered after a restart.
// processGroupMessages injects recent conversation history for these groups
// so the fresh session has context despite the session being cleared.
const recoveryGroups = new Set<string>();

// Track consecutive IM health check failures per JID for safe auto-unbind
const imHealthCheckFailCounts = new Map<string, number>();

const { setCursors, advanceCursors } = createCursorStateHelpers({
  getLastAgentTimestamp: () => lastAgentTimestamp,
  getLastCommittedCursor: () => lastCommittedCursor,
  saveState: () => saveState(),
});

const {
  cleanStreamingBufferDir,
  flushStreamingBuffer,
  saveInterruptedStreamingMessages,
  recoverStreamingBuffer,
  startStreamingBuffer,
  stopStreamingBuffer,
} = createStreamingBufferManager({
  dataDir: DATA_DIR,
  assistantName: ASSISTANT_NAME,
  shutdownSavedJids,
  logger,
  getActiveStreamingTexts,
  ensureChatExists,
  storeMessageDirect,
});

let handleCommand: (
  chatJid: string,
  command: string,
) => Promise<string | null> = async () => null;
let handleSpawnCommand: (
  chatJid: string,
  rawMessage: string,
  sourceImJid?: string,
) => Promise<string> = async () =>
  '用法: /sw <任务描述>\n在当前工作区创建并行任务';

const {
  unbindImGroup,
  resolveEffectiveFolder,
  resolveEffectiveGroup,
  resolveOwnerHomeFolder,
  extractLocalImImagePaths,
  retryImOperation,
  sendImWithRetry,
  sendImWithFailTracking,
  setActiveImReplyRoute,
  clearActiveImReplyRoute,
  buildOnNewChat,
  buildOnBotRemovedFromGroup,
  buildTelegramBotAddedHandler,
  buildIsChatAuthorized,
  buildOnPairAttempt,
  buildResolveEffectiveChatJid,
  buildOnAgentMessage,
  shouldProcessGroupMessage,
  handleCardInterrupt,
  connectUserIMChannels,
} = createImRoutingHelpers({
  queue,
  registerGroup,
  registeredGroups,
  imSendFailCounts,
  imHealthCheckFailCounts,
  lastAgentTimestamp,
  activeImReplyRoutes,
  activeRouteUpdaters,
  handleCommand: (chatJid, command) => handleCommand(chatJid, command),
  processAgentConversation,
  formatMessages,
  collectMessageImages,
  emptyCursor: EMPTY_CURSOR,
});

({ handleCommand, handleSpawnCommand } = createSlashCommandHandlers({
  queue,
  sessions,
  registeredGroups,
  imSendFailCounts,
  imHealthCheckFailCounts,
  setCursors,
  registerGroup,
  unbindImGroup,
  resolveEffectiveGroup,
  processAgentConversation,
}));

function recoverStuckPendingGroups(): void {
  recoverStuckPendingGroupsHelper({
    queue,
    logger,
    idleThresholdMs: STUCK_RUNNER_IDLE_MS,
  });
}

function recoverPendingMessages(): void {
  recoverPendingMessagesHelper({
    logger,
    queue,
    recoveryGroups,
    getRegisteredGroups: () => registeredGroups,
    getLastCommittedCursor: () => lastCommittedCursor,
    getSessions: () => sessions,
    getMessagesSince,
    clearPersistedRuntimeStateForRecovery,
  });
}

function recoverConversationAgents(): void {
  recoverConversationAgentsHelper({
    logger,
    queue,
    assistantName: ASSISTANT_NAME,
    emptyCursor: EMPTY_CURSOR,
    getLastAgentTimestamp: () => lastAgentTimestamp,
    getSessions: () => sessions,
    listActiveConversationAgents,
    updateAgentStatus,
    broadcastAgentStatus,
    getMessagesSince,
    getRuntimeSession,
    clearPersistedRuntimeStateForRecovery,
    storeMessageDirect,
    broadcastNewMessage,
    processAgentConversation,
  });
}

const { startMessageLoop } = createMessageLoop({
  queue,
  pollInterval: POLL_INTERVAL,
  emptyCursor: EMPTY_CURSOR,
  registeredGroups,
  lastAgentTimestamp,
  recoveryGroups,
  getGlobalMessageCursor: () => globalMessageCursor,
  setGlobalMessageCursor: (cursor) => {
    globalMessageCursor = cursor;
  },
  saveState,
  setCursors,
  getStuckRunnerCheckCounter: () => stuckRunnerCheckCounter,
  resetStuckRunnerCheckCounter: () => {
    stuckRunnerCheckCounter = 0;
  },
  incrementStuckRunnerCheckCounter: () => ++stuckRunnerCheckCounter,
  stuckRunnerCheckIntervalPolls: STUCK_RUNNER_CHECK_INTERVAL_POLLS,
  recoverStuckPendingGroups,
  isShuttingDown: () => shuttingDown,
  formatMessages,
  collectMessageImages,
  isGroupShared,
  sendBillingDeniedMessage,
  imManager,
  activeRouteUpdaters,
});

/**
 * Write usage records from a usage event to the database.
 * Handles both modelUsage (per-model breakdown) and legacy flat format.
 * When modelUsage is present, root-level cache tokens are assigned to the first model entry.
 */
function writeUsageRecords(opts: {
  userId: string;
  groupFolder: string;
  messageId?: string;
  agentId?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
    modelUsage?: Record<
      string,
      { inputTokens: number; outputTokens: number; costUSD: number }
    >;
  };
}): void {
  const { userId, groupFolder, messageId, agentId, usage } = opts;
  if (usage.modelUsage) {
    const models = Object.entries(usage.modelUsage);
    let cacheReadAssigned = false;
    for (const [model, mu] of models) {
      insertUsageRecord({
        userId,
        groupFolder,
        agentId,
        messageId,
        model,
        inputTokens: mu.inputTokens,
        outputTokens: mu.outputTokens,
        // Assign root-level cache tokens to the first model entry
        cacheReadInputTokens: cacheReadAssigned
          ? 0
          : usage.cacheReadInputTokens,
        cacheCreationInputTokens: cacheReadAssigned
          ? 0
          : usage.cacheCreationInputTokens,
        costUSD: mu.costUSD,
        durationMs: usage.durationMs,
        numTurns: usage.numTurns,
        source: 'agent',
      });
      cacheReadAssigned = true;
    }
  } else {
    insertUsageRecord({
      userId,
      groupFolder,
      agentId,
      messageId,
      model: 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      costUSD: usage.costUSD,
      durationMs: usage.durationMs,
      numTurns: usage.numTurns,
      source: 'agent',
    });
  }
}

function sendSystemMessage(jid: string, type: string, detail: string): void {
  const msgId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(jid);
  storeMessageDirect(
    msgId,
    jid,
    '__system__',
    'system',
    `${type}:${detail}`,
    timestamp,
    true,
  );
  broadcastNewMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: '__system__',
    sender_name: 'system',
    content: `${type}:${detail}`,
    timestamp,
    is_from_me: true,
  });
}

function sendBillingDeniedMessage(jid: string, content: string): string {
  const msgId = `sys_quota_${Date.now()}`;
  const timestamp = new Date().toISOString();
  ensureChatExists(jid);
  storeMessageDirect(
    msgId,
    jid,
    '__billing__',
    ASSISTANT_NAME,
    content,
    timestamp,
    true,
  );
  broadcastNewMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: '__billing__',
    sender_name: ASSISTANT_NAME,
    content,
    timestamp,
    is_from_me: true,
  });
  return msgId;
}

function getEffectiveRuntime(group: RegisteredGroup): RuntimeType {
  return group.runtime ?? getSystemSettings().defaultRuntime;
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  // Skip Feishu Reaction when a streaming card is active — the card itself
  // serves as a live typing indicator.
  if (isTyping && hasActiveStreamingSession(jid)) {
    broadcastTyping(jid, isTyping);
    return;
  }
  await imManager.setTyping(jid, isTyping);
  broadcastTyping(jid, isTyping);
}

interface SendMessageOptions {
  /** Whether to forward the reply to the IM channel (Feishu/Telegram). Defaults to true for IM JIDs. */
  sendToIM?: boolean;
  /** Pre-computed local image paths to attach to IM messages. Avoids redundant filesystem scans. */
  localImagePaths?: string[];
  /** Message source identifier (e.g. 'scheduled_task') for frontend routing. */
  source?: string;
  /** Metadata used to preserve Claude SDK turn semantics for persisted messages. */
  messageMeta?: {
    turnId?: string;
    sessionId?: string;
    sdkMessageUuid?: string;
    sourceKind?:
      | 'sdk_final'
      | 'sdk_send_message'
      | 'interrupt_partial'
      | 'overflow_partial'
      | 'compact_partial'
      | 'legacy'
      | 'auto_continue';
    finalizationReason?: 'completed' | 'interrupted' | 'error';
  };
}

/**
 * One-time migration: copy system-level IM config → admin's per-user config.
 * Safe to call repeatedly — writes a flag file after first successful run.
 */
function migrateSystemIMToPerUser(): void {
  const flagFile = path.join(DATA_DIR, 'config', '.im-config-migrated');
  if (fs.existsSync(flagFile)) return;

  try {
    // Find first admin user
    const adminResult = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    });
    const admin = adminResult.users[0];
    if (!admin) {
      // No admin yet (fresh install) — nothing to migrate
      return;
    }

    let migratedFeishu = false;
    let migratedTelegram = false;

    // Feishu: copy system config → admin per-user (if admin has no per-user config)
    const existingUserFeishu = getUserFeishuConfig(admin.id);
    if (!existingUserFeishu) {
      const { config: sysFeishu, source: feishuSource } =
        getFeishuProviderConfigWithSource();
      if (feishuSource !== 'none' && sysFeishu.appId && sysFeishu.appSecret) {
        saveUserFeishuConfig(admin.id, {
          appId: sysFeishu.appId,
          appSecret: sysFeishu.appSecret,
          enabled: sysFeishu.enabled,
        });
        migratedFeishu = true;
      }
    }

    // Telegram: copy system config → admin per-user (if admin has no per-user config)
    const existingUserTelegram = getUserTelegramConfig(admin.id);
    if (!existingUserTelegram) {
      const { config: sysTelegram, source: telegramSource } =
        getTelegramProviderConfigWithSource();
      if (telegramSource !== 'none' && sysTelegram.botToken) {
        saveUserTelegramConfig(admin.id, {
          botToken: sysTelegram.botToken,
          proxyUrl: sysTelegram.proxyUrl,
          enabled: sysTelegram.enabled,
        });
        migratedTelegram = true;
      }
    }

    // Write flag file (even if nothing was migrated — to avoid re-checking)
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, new Date().toISOString() + '\n', 'utf-8');

    if (migratedFeishu || migratedTelegram) {
      logger.info(
        {
          adminId: admin.id,
          feishu: migratedFeishu,
          telegram: migratedTelegram,
        },
        'Migrated system-level IM config to admin per-user config',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to migrate system-level IM config (non-fatal)',
    );
  }
}

function loadState(): void {
  // Load from SQLite
  const persistedTimestamp = getRouterState('last_timestamp') || '';
  const lastTimestampId = getRouterState('last_timestamp_id') || '';
  globalMessageCursor = {
    timestamp: persistedTimestamp,
    id: lastTimestampId,
  };
  const loadCursorMap = (key: string): Record<string, MessageCursor> => {
    const raw = getRouterState(key);
    try {
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const normalized: Record<string, MessageCursor> = {};
      for (const [jid, v] of Object.entries(parsed)) {
        normalized[jid] = normalizeCursor(v);
      }
      return normalized;
    } catch {
      logger.warn(`Corrupted ${key} in DB, resetting`);
      return {};
    }
  };
  Object.keys(lastAgentTimestamp).forEach((key) => {
    delete lastAgentTimestamp[key];
  });
  Object.assign(lastAgentTimestamp, loadCursorMap('last_agent_timestamp'));
  Object.keys(lastCommittedCursor).forEach((key) => {
    delete lastCommittedCursor[key];
  });
  Object.assign(lastCommittedCursor, loadCursorMap('last_committed_cursor'));

  // Migration: fill in missing lastCommittedCursor entries from lastAgentTimestamp.
  // The original migration only triggered when lastCommittedCursor was completely empty,
  // missing the case where some keys exist but others don't (e.g. new IM groups).
  {
    let migrated = false;
    for (const [jid, cursor] of Object.entries(lastAgentTimestamp)) {
      if (!lastCommittedCursor[jid]) {
        lastCommittedCursor[jid] = cursor;
        migrated = true;
      }
    }
    if (migrated) {
      logger.info(
        'Migrated missing lastCommittedCursor entries from lastAgentTimestamp',
      );
      saveState();
    }
  }

  Object.keys(sessions).forEach((key) => {
    delete sessions[key];
  });
  Object.assign(sessions, getAllSessions());
  Object.keys(registeredGroups).forEach((key) => {
    delete registeredGroups[key];
  });
  Object.assign(registeredGroups, getAllRegisteredGroups());

  // Restore persisted OOM counters
  for (const { key, value } of getRouterStateByPrefix('oom_exits:')) {
    const folder = key.slice('oom_exits:'.length);
    const count = parseInt(value, 10);
    if (count > 0) {
      consecutiveOomExits[folder] = count;
      logger.info({ folder, count }, 'Restored OOM counter from DB');
    }
  }

  // Auto-register default groups from config/default-groups.json
  const defaultGroupsPath = path.resolve(
    process.cwd(),
    'config',
    'default-groups.json',
  );
  if (fs.existsSync(defaultGroupsPath)) {
    try {
      const defaults = JSON.parse(
        fs.readFileSync(defaultGroupsPath, 'utf-8'),
      ) as Array<{
        jid: string;
        name: string;
        folder: string;
      }>;
      for (const g of defaults) {
        if (!registeredGroups[g.jid]) {
          registerGroup(g.jid, {
            name: g.name,
            folder: g.folder,
            added_at: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load default groups config');
    }
  }

  // Ensure every active user has a home group (is_home=true).
  // Admin → folder='main', executionMode='host'
  // Member → folder='home-{userId}', executionMode='container'
  try {
    // Paginate through all active users
    const activeUsers: Array<{ id: string; role: string; username: string }> =
      [];
    {
      let page = 1;
      while (true) {
        const result = listUsers({ status: 'active', page, pageSize: 200 });
        activeUsers.push(...result.users);
        if (activeUsers.length >= result.total) break;
        page++;
      }
    }
    for (const user of activeUsers) {
      const homeJid = ensureUserHomeGroup(
        user.id,
        user.role as 'admin' | 'member',
        user.username,
      );
      // Always refresh this entry from DB to pick up any patches (is_home, executionMode, etc.)
      const freshGroup = getRegisteredGroup(homeJid);
      if (freshGroup) {
        registeredGroups[homeJid] = freshGroup;
      } else if (!registeredGroups[homeJid]) {
        Object.keys(registeredGroups).forEach((key) => {
          delete registeredGroups[key];
        });
        Object.assign(registeredGroups, getAllRegisteredGroups());
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to ensure user home groups');
  }

  // Enforce execution mode on all is_home groups:
  // - admin home → host mode
  // - member home → container mode
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!group.is_home) continue;

    // Determine expected mode based on the owner's role
    // Admin home groups use host mode, member home groups use container mode
    const isAdminHome = group.folder === MAIN_GROUP_FOLDER;
    const expectedMode = isAdminHome ? 'host' : 'container';

    if (group.executionMode !== expectedMode) {
      group.executionMode = expectedMode;
      setRegisteredGroup(jid, group);
      registeredGroups[jid] = group;
      // 清除旧 session，避免恢复不兼容的 session
      if (sessions[group.folder]) {
        logger.info(
          { folder: group.folder, expectedMode },
          'Clearing stale session during execution mode migration',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
    }
  }

  // Migrate shared global CLAUDE.md → per-user user-global directories
  migrateGlobalMemoryToPerUser();

  // Initialize per-user global CLAUDE.md from template for users missing it
  const templatePath = path.resolve(
    process.cwd(),
    'config',
    'global-claude-md.template.md',
  );
  if (fs.existsSync(templatePath)) {
    const template = fs.readFileSync(templatePath, 'utf-8');
    const userGlobalBase = path.join(GROUPS_DIR, 'user-global');
    // Ensure every active user has a user-global dir
    try {
      let page = 1;
      const allUsers: Array<{ id: string }> = [];
      while (true) {
        const result = listUsers({ status: 'active', page, pageSize: 200 });
        allUsers.push(...result.users);
        if (allUsers.length >= result.total) break;
        page++;
      }
      for (const u of allUsers) {
        const userDir = path.join(userGlobalBase, u.id);
        fs.mkdirSync(userDir, { recursive: true });
        const userClaudeMd = path.join(userDir, 'CLAUDE.md');
        if (!fs.existsSync(userClaudeMd)) {
          try {
            fs.writeFileSync(userClaudeMd, template, { flag: 'wx' });
            logger.info(
              { userId: u.id },
              'Initialized user-global CLAUDE.md from template',
            );
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
              logger.warn(
                { userId: u.id, err },
                'Failed to initialize user-global CLAUDE.md',
              );
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize user-global CLAUDE.md files');
    }
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', globalMessageCursor.timestamp);
  setRouterState('last_timestamp_id', globalMessageCursor.id);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState('last_committed_cursor', JSON.stringify(lastCommittedCursor));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Sync group metadata from Feishu.
 * Fetches all bot groups and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  // Sync groups via any connected user's Feishu instance
  const connectedUserIds = imManager.getConnectedUserIds();
  for (const uid of connectedUserIds) {
    if (imManager.isFeishuConnected(uid)) {
      await imManager.syncFeishuGroups(uid);
      break; // Only need one sync
    }
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.startsWith('feishu:'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMessages(messages: NewMessage[], isShared = false): string {
  const lines = messages.map((m) => {
    const content = isShared ? `[${m.sender_name}] ${m.content}` : m.content;
    const sourceJid = m.source_jid || m.chat_jid;
    const channelType = getChannelType(sourceJid);
    let sourceAttr = '';
    if (channelType) {
      const chatId = extractChatId(sourceJid);
      sourceAttr = ` source="${escapeXml(channelType)}:${escapeXml(chatId)}"`;
    }
    return `<message sender="${escapeXml(m.sender_name)}"${sourceAttr} time="${m.timestamp}">${escapeXml(content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

function collectMessageImages(
  chatJid: string,
  messages: NewMessage[],
): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const msg of messages) {
    if (!msg.attachments) continue;
    try {
      const parsed = JSON.parse(msg.attachments);
      const normalized = normalizeImageAttachments(parsed, {
        onMimeMismatch: ({ declaredMime, detectedMime }) => {
          logger.warn(
            { chatJid, messageId: msg.id, declaredMime, detectedMime },
            'Attachment MIME mismatch detected, using detected MIME',
          );
        },
      });
      for (const item of normalized) {
        images.push({ data: item.data, mimeType: item.mimeType });
      }
    } catch (err) {
      logger.warn(
        { chatJid, messageId: msg.id },
        'Failed to parse message attachments',
      );
    }
  }
  return images;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 *
 * Uses streaming output: agent results are sent to Feishu as they arrive.
 * The container stays alive for idleTimeout after each result, allowing
 * rapid-fire messages to be piped in without spawning a new container.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group = registeredGroups[chatJid];
  if (!group) {
    // Group may have been created after loadState (e.g., during setup/registration)
    Object.keys(registeredGroups).forEach((key) => {
      delete registeredGroups[key];
    });
    Object.assign(registeredGroups, getAllRegisteredGroups());
    group = registeredGroups[chatJid];
  }
  if (!group) return true;

  // activation_mode === 'disabled' 时忽略所有消息（DM 和群聊）
  if (group.activation_mode === 'disabled') {
    logger.debug({ chatJid }, 'Group activation_mode is disabled, skipping');
    return true;
  }

  const resolved = resolveEffectiveGroup(group);
  let effectiveGroup = resolved.effectiveGroup;
  let isHome = resolved.isHome;

  // Get all messages since last agent interaction
  const sinceCursor = lastAgentTimestamp[chatJid] || EMPTY_CURSOR;
  const missedMessages = getMessagesSince(chatJid, sinceCursor);

  if (missedMessages.length === 0) return true;

  // Admin home is shared as web:main, so select runtime owner from the latest
  // active admin sender to avoid writing global memory into another admin's
  // user-global directory.
  if (chatJid === 'web:main' && effectiveGroup.is_home) {
    for (let i = missedMessages.length - 1; i >= 0; i--) {
      const sender = missedMessages[i]?.sender;
      if (
        !sender ||
        sender === 'happypaw-agent' ||
        sender === LEGACY_AGENT_SENDER ||
        sender === '__system__'
      )
        continue;
      const senderUser = getUserById(sender);
      if (senderUser?.status === 'active' && senderUser.role === 'admin') {
        effectiveGroup = { ...effectiveGroup, created_by: senderUser.id };
        break;
      }
    }
  }

  // Direct IM chats reply to themselves. Routed IM messages keep their original
  // source_jid so workspace-bound conversations can reply back to the sender
  // without mirroring every Web reply into IM.
  //
  // When messages from multiple sources (web + IM) are batched together, only
  // route replies to IM if ALL messages came from the same IM source. If any
  // message originated from web, the web user expects replies on web only — do
  // not broadcast to IM (#99).
  const directImReply = getChannelType(chatJid) !== null;
  let replySourceImJid: string | null = null;
  if (!directImReply) {
    // chatJid is a web channel — check if ALL messages share the same IM source
    const firstSourceJid = missedMessages[0]?.source_jid || chatJid;
    const allSameImSource =
      getChannelType(firstSourceJid) !== null &&
      missedMessages.every((m) => (m.source_jid || chatJid) === firstSourceJid);
    if (allSameImSource) {
      replySourceImJid = firstSourceJid;
    }
  } else {
    // chatJid is an IM channel — reply directly
    replySourceImJid = chatJid;
  }
  // Publish the current IM reply route so the IPC watcher can forward
  // send_message outputs to the correct IM channel.
  setActiveImReplyRoute(effectiveGroup.folder, replySourceImJid);

  const shared = isGroupShared(group.folder);
  let prompt = formatMessages(missedMessages, shared);

  // Recovery mode: session was cleared to prevent session ghost, so inject
  // recent conversation history to give the fresh session context.
  const isRecovery = recoveryGroups.delete(chatJid);
  if (isRecovery) {
    const RECOVERY_HISTORY_LIMIT = 20;
    const recentHistory = getMessagesPage(
      chatJid,
      undefined,
      RECOVERY_HISTORY_LIMIT,
    );
    // getMessagesPage returns DESC order; reverse to chronological, exclude
    // the pending messages themselves (already in prompt).
    const pendingIds = new Set(missedMessages.map((m) => m.id));
    const historyMsgs = recentHistory
      .reverse()
      .filter((m) => !pendingIds.has(m.id));
    if (historyMsgs.length > 0) {
      const historyLines = historyMsgs.map((m) => {
        const role = m.is_from_me ? 'assistant' : m.sender_name;
        const truncated =
          m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
        // Strip lone surrogates to avoid API JSON errors
        const cleaned = truncated.replace(/[\uD800-\uDFFF]/g, '');
        return `[${role}] ${cleaned}`;
      });
      prompt =
        '<system_context>\n' +
        '服务刚重启，当前为新会话。以下是重启前的最近对话记录，供你了解上下文：\n\n' +
        historyLines.join('\n') +
        '\n</system_context>\n\n' +
        prompt;
      logger.info(
        { group: group.name, historyCount: historyMsgs.length },
        'Recovery: injected recent conversation history into prompt',
      );
    }
  }

  const images = collectMessageImages(chatJid, missedMessages);
  const imagesForAgent = images.length > 0 ? images : undefined;

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      directImReply,
      imageCount: images.length,
      shared,
      isRecovery,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, getSystemSettings().idleTimeout);
  };

  await setTyping(chatJid, true);
  let hadError = false;
  let sentReply = false;
  let lastError = '';
  let cursorCommitted = false;
  let lastReplyMsgId: string | undefined;
  let lastSavedTurnId: string | undefined; // tracks last turnId saved to DB, prevents UPSERT overwrite
  const queryTaskIds = new Set<string>();
  const lastProcessed = missedMessages[missedMessages.length - 1];

  // ── Feishu Streaming Card ──
  // Create a streaming session for Feishu channels (typing-machine effect).
  // Non-Feishu channels get undefined → all streaming logic is no-op.
  let streamingSessionJid = replySourceImJid ?? chatJid;
  const makeOnCardCreated = (jid: string) => (messageId: string) =>
    registerMessageIdMapping(messageId, jid);
  let streamingSession = imManager.createStreamingSession(
    streamingSessionJid,
    makeOnCardCreated(streamingSessionJid),
  );
  let streamingAccumulatedText = '';
  let streamingAccumulatedThinking = '';
  let streamInterrupted = false;
  if (streamingSession) {
    registerStreamingSession(streamingSessionJid, streamingSession);
    logger.debug({ chatJid }, 'Streaming card session created for Feishu');
  }

  // ── Dynamic reply route updater ──
  // Allows IPC-injected messages (from web.ts / IM polling) to update the
  // reply routing target without killing the agent process.  This replaces
  // the old "closeStdin + restart" approach for home groups (#99).
  activeRouteUpdaters.set(effectiveGroup.folder, (newSourceJid) => {
    const newImJid =
      newSourceJid && getChannelType(newSourceJid) ? newSourceJid : null;
    // New IPC user message arrived — reset sentReply so the next result
    // can be delivered to IM. This is the correct place to reset, NOT
    // in the streaming session rebuild (which also fires on SDK Task
    // completion and would cause multi-result IM spam).
    sentReply = false;
    if (newImJid === replySourceImJid) return; // no change
    logger.debug(
      { chatJid, oldRoute: replySourceImJid, newRoute: newImJid },
      'Reply route updated via IPC injection',
    );
    replySourceImJid = newImJid;
    setActiveImReplyRoute(effectiveGroup.folder, replySourceImJid);

    // Rebuild streaming session if the target channel changed.
    // When the route is cleared to null (web message injected into IM-originated
    // session), fall back to the web JID — NOT the original IM chatJid — so the
    // Feishu streaming card is properly disposed.
    const newStreamingJid =
      replySourceImJid ??
      (directImReply ? `web:${effectiveGroup.folder}` : chatJid);
    if (newStreamingJid !== streamingSessionJid) {
      if (streamingSession) {
        if (streamingSession.isActive()) streamingSession.dispose();
        unregisterStreamingSession(streamingSessionJid);
      }
      streamingSessionJid = newStreamingJid;
      streamingSession = imManager.createStreamingSession(
        streamingSessionJid,
        makeOnCardCreated(streamingSessionJid),
      );
      streamingAccumulatedText = '';
      streamingAccumulatedThinking = '';
      if (streamingSession) {
        registerStreamingSession(streamingSessionJid, streamingSession);
      }
    }
  });

  const pickRunningTaskForNotification = (): string | null => {
    const runningInQuery = Array.from(queryTaskIds)
      .map((id) => getAgent(id))
      .filter(
        (a): a is NonNullable<ReturnType<typeof getAgent>> =>
          !!a &&
          a.kind === 'task' &&
          a.chat_jid === chatJid &&
          a.status === 'running',
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (runningInQuery.length > 0) {
      return runningInQuery[0].id;
    }
    const runningInChat = listAgentsByJid(chatJid)
      .filter((a) => a.kind === 'task' && a.status === 'running')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return runningInChat[0]?.id || null;
  };

  const commitCursor = (): void => {
    if (cursorCommitted) return;
    advanceCursors(chatJid, {
      timestamp: lastProcessed.timestamp,
      id: lastProcessed.id,
    });
    cursorCommitted = true;
  };

  if (effectiveGroup.created_by) {
    const owner = getUserById(effectiveGroup.created_by);
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccessFresh(
        effectiveGroup.created_by,
        owner.role,
      );
      if (!accessResult.allowed) {
        const sysMsg = formatBillingAccessDeniedMessage(accessResult);
        sendBillingDeniedMessage(chatJid, sysMsg);
        commitCursor();
        await setTyping(chatJid, false);
        logger.info(
          {
            chatJid,
            userId: effectiveGroup.created_by,
            reason: accessResult.reason,
            blockType: accessResult.blockType,
          },
          'Billing access denied inside processGroupMessages',
        );
        return true;
      }
    }
  }

  let output:
    | { status: 'success' | 'error' | 'closed'; error?: string }
    | undefined;
  const activeMainSession = getRuntimeSession(effectiveGroup.folder);
  let activeSessionId =
    activeMainSession &&
    activeMainSession.runtime === getEffectiveRuntime(effectiveGroup)
      ? activeMainSession.sessionId
      : undefined;
  try {
    output = await runAgent(
      effectiveGroup,
      prompt,
      chatJid,
      lastProcessed.id,
      async (result) => {
        try {
          if (result.newSessionId && result.status !== 'error') {
            activeSessionId = result.newSessionId;
          }
          // 流式事件处理 - 广播 WebSocket + 持久化 SDK Task 生命周期到 DB
          if (result.status === 'stream' && result.streamEvent) {
            broadcastStreamEvent(chatJid, result.streamEvent);

            // ── 累积 text_delta / thinking_delta 文本（中断时用于保存已输出内容）──
            if (
              result.streamEvent.eventType === 'text_delta' &&
              result.streamEvent.text
            ) {
              streamingAccumulatedText += result.streamEvent.text;
            }
            if (
              result.streamEvent.eventType === 'thinking_delta' &&
              result.streamEvent.text
            ) {
              streamingAccumulatedThinking += result.streamEvent.text;
            }

            // ── Feed stream events into Feishu streaming card ──
            // IPC 注入的新 query 开始时，旧卡片已 complete()/abort()，
            // 需要为新 query 重建流式卡片并重置会话级状态。
            if (streamingSession && !streamingSession.isActive()) {
              unregisterStreamingSession(streamingSessionJid);
              streamingAccumulatedText = '';
              streamingAccumulatedThinking = '';
              // Note: sentReply is NOT reset here. Resetting it would cause
              // subsequent SDK Task results to be sent to IM as separate messages,
              // spamming the IM channel. The first substantive reply already
              // delivered the main content; follow-up results are DB-only.
              streamInterrupted = false;
              streamingSession = imManager.createStreamingSession(
                streamingSessionJid,
                makeOnCardCreated(streamingSessionJid),
              );
              if (streamingSession) {
                registerStreamingSession(streamingSessionJid, streamingSession);
                logger.debug(
                  { chatJid },
                  'Rebuilt streaming card for IPC-injected query',
                );
              }
            }
            if (streamingSession) {
              feedStreamEventToCard(
                streamingSession,
                result.streamEvent,
                streamingAccumulatedText,
              );
            }

            // ── 中断时立即保存已输出内容 ──
            // agent-runner 中断后不退出进程（进入 waitForIpcMessage），
            // finally 块不会执行，必须在此处立即保存。
            if (
              result.streamEvent.eventType === 'status' &&
              result.streamEvent.statusText === 'interrupted'
            ) {
              streamInterrupted = true;
              // Skip if shutdown handler already saved this text (prevents duplicates)
              const inlineWebJid = chatJid.startsWith('web:')
                ? chatJid
                : `web:${effectiveGroup.folder}`;
              const inlineAlreadySaved =
                shutdownSavedJids.has(chatJid) ||
                shutdownSavedJids.has(inlineWebJid);
              if (!sentReply && !inlineAlreadySaved) {
                const interruptedText = buildInterruptedReply(
                  streamingAccumulatedText,
                  streamingAccumulatedThinking,
                );
                try {
                  if (streamingSession?.isActive()) {
                    await streamingSession.abort('已中断').catch(() => {});
                  }
                  lastReplyMsgId = await sendMessage(chatJid, interruptedText, {
                    sendToIM: false,
                    messageMeta: {
                      turnId: result.streamEvent.turnId || lastProcessed.id,
                      sessionId:
                        result.streamEvent.sessionId || activeSessionId,
                      sourceKind: 'interrupt_partial',
                      finalizationReason: 'interrupted',
                    },
                  });
                  sentReply = true;
                  clearStreamingSnapshot(chatJid);
                  streamingAccumulatedText = '';
                  streamingAccumulatedThinking = '';
                  commitCursor();
                } catch (err) {
                  logger.warn(
                    { err, chatJid },
                    'Failed to save interrupted text on status event',
                  );
                }
              }
            }

            // Persist SDK Task lifecycle to DB so tabs survive page refresh
            const se = result.streamEvent;
            if (
              (se.eventType === 'task_start' && se.toolUseId) ||
              (se.eventType === 'tool_use_start' &&
                se.toolName === 'Task' &&
                se.toolUseId)
            ) {
              try {
                const taskId = se.toolUseId;
                queryTaskIds.add(taskId);
                const existing = getAgent(taskId);
                const desc = se.taskDescription || se.toolInputSummary || '';
                const taskName = desc.slice(0, 40) || existing?.name || 'Task';
                if (!existing) {
                  createAgent({
                    id: taskId,
                    group_folder: group.folder,
                    chat_jid: chatJid,
                    name: taskName,
                    prompt: desc,
                    status: 'running',
                    kind: 'task',
                    created_by: null,
                    created_at: new Date().toISOString(),
                    completed_at: null,
                    result_summary: null,
                    last_im_jid: null,
                    spawned_from_jid: null,
                  });
                } else if (se.taskDescription) {
                  updateAgentInfo(
                    taskId,
                    se.taskDescription.slice(0, 40),
                    se.taskDescription,
                  );
                }
                broadcastAgentStatus(
                  chatJid,
                  taskId,
                  'running',
                  taskName,
                  desc,
                  undefined,
                  'task',
                );
              } catch (err) {
                logger.warn(
                  { err, toolUseId: se.toolUseId },
                  'Failed to persist task_start to DB',
                );
              }
            }
            if (se.eventType === 'tool_use_end' && se.toolUseId) {
              try {
                const existing = getAgent(se.toolUseId);
                if (
                  existing &&
                  existing.kind === 'task' &&
                  existing.status === 'running'
                ) {
                  updateAgentStatus(se.toolUseId, 'completed');
                  queryTaskIds.delete(existing.id);
                  broadcastAgentStatus(
                    chatJid,
                    existing.id,
                    'completed',
                    existing.name,
                    existing.prompt,
                    existing.result_summary || '任务已完成',
                    'task',
                  );
                }
              } catch (err) {
                logger.warn(
                  { err, toolUseId: se.toolUseId },
                  'Failed to persist tool_use_end to DB',
                );
              }
            }
            if (se.eventType === 'task_notification' && se.taskId) {
              try {
                const status =
                  se.taskStatus === 'completed' ? 'completed' : 'error';
                const summary = se.taskSummary?.slice(0, 2000);
                let targetTaskId = se.taskId;
                let existing = getAgent(targetTaskId);
                if (!existing || existing.kind !== 'task') {
                  // agent-runner now translates SDK task_id → toolUseId,
                  // so this fallback should rarely trigger. Keep as safety net.
                  const fallbackTaskId = pickRunningTaskForNotification();
                  if (fallbackTaskId) {
                    targetTaskId = fallbackTaskId;
                    existing = getAgent(fallbackTaskId);
                    logger.debug(
                      {
                        chatJid,
                        sdkTaskId: se.taskId,
                        mappedTaskId: fallbackTaskId,
                      },
                      'Task notification ID fallback to running task',
                    );
                  }
                }

                if (!existing) {
                  createAgent({
                    id: targetTaskId,
                    group_folder: group.folder,
                    chat_jid: chatJid,
                    name: 'Task',
                    prompt: '',
                    status,
                    kind: 'task',
                    created_by: null,
                    created_at: new Date().toISOString(),
                    completed_at: new Date().toISOString(),
                    result_summary: summary || null,
                    last_im_jid: null,
                    spawned_from_jid: null,
                  });
                  broadcastAgentStatus(
                    chatJid,
                    targetTaskId,
                    status,
                    'Task',
                    '',
                    summary,
                    'task',
                  );
                } else if (existing.kind === 'task') {
                  updateAgentStatus(existing.id, status, summary);
                  queryTaskIds.delete(existing.id);
                  broadcastAgentStatus(
                    chatJid,
                    existing.id,
                    status,
                    existing.name,
                    existing.prompt,
                    summary,
                    'task',
                  );
                }
              } catch (err) {
                logger.warn(
                  { err, taskId: se.taskId },
                  'Failed to persist task_notification to DB',
                );
              }
            }

            // Persist token usage to the latest agent message + usage_records
            if (se.eventType === 'usage' && se.usage) {
              try {
                updateLatestMessageTokenUsage(
                  chatJid,
                  JSON.stringify(se.usage),
                  lastReplyMsgId,
                  se.usage.costUSD,
                );

                // Write to usage_records + usage_daily_summary
                writeUsageRecords({
                  userId: effectiveGroup.created_by || 'system',
                  groupFolder: effectiveGroup.folder,
                  messageId: lastReplyMsgId,
                  usage: se.usage,
                });

                logger.debug(
                  {
                    chatJid,
                    msgId: lastReplyMsgId,
                    costUSD: se.usage.costUSD,
                    inputTokens: se.usage.inputTokens,
                  },
                  'Token usage persisted',
                );

                // Update billing monthly usage
                const ownerGroup = registeredGroups[chatJid];
                if (ownerGroup?.created_by && se.usage.costUSD) {
                  try {
                    const effective = updateUsage(
                      ownerGroup.created_by,
                      se.usage.costUSD,
                      se.usage.inputTokens || 0,
                      se.usage.outputTokens || 0,
                    );
                    deductUsageCost(
                      ownerGroup.created_by,
                      se.usage.costUSD,
                      lastReplyMsgId || chatJid,
                      effective,
                    );
                    // Broadcast real-time billing update to the user
                    const owner = getUserById(ownerGroup.created_by);
                    if (owner && owner.role !== 'admin') {
                      const freshAccess = checkBillingAccessFresh(
                        ownerGroup.created_by,
                        owner.role,
                      );
                      if (freshAccess.usage) {
                        broadcastBillingUpdate(ownerGroup.created_by, {
                          ...freshAccess,
                        });
                      }
                    }
                  } catch (billingErr) {
                    logger.warn(
                      { err: billingErr, chatJid },
                      'Failed to update billing usage',
                    );
                  }
                }
              } catch (err) {
                logger.warn({ err, chatJid }, 'Failed to persist token usage');
              }
            }

            // Reset idle timer on stream events so long-running tool calls
            // (e.g. MCP batch writes) don't get killed while the agent is
            // actively working. Previously only final results triggered a reset.
            resetIdleTimer();
            return;
          }

          // Streaming output callback — called for each agent result
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            let text = stripAgentInternalTags(raw);
            if (
              result.sourceKind === 'overflow_partial' ||
              result.sourceKind === 'compact_partial'
            ) {
              text = buildOverflowPartialReply(text);
            }
            // auto_continue outputs that consist solely of system-maintenance
            // acknowledgements (e.g. "OK", "已更新 CLAUDE.md") are suppressed from
            // IM delivery. These arise when the agent's session transcript contains
            // memory-flush / CLAUDE.md-update context from the compaction pipeline
            // and the agent echoes it back in the resumption query. Substantive
            // user-facing continuations (longer replies or actual task resumption)
            // pass through normally. See issue #275.
            if (
              result.sourceKind === 'auto_continue' &&
              isSystemMaintenanceNoise(text)
            ) {
              logger.info(
                { group: group.name, textLen: text.length },
                'auto_continue output suppressed (system maintenance noise)',
              );
              return;
            }
            logger.info(
              { group: group.name },
              `Agent output: ${raw.slice(0, 200)}`,
            );
            if (text) {
              // Stop typing indicator before sending — clears the 4s refresh timer
              // so it doesn't keep firing while the agent stays alive in idle state.
              await setTyping(chatJid, false);
              const localImagePaths = extractLocalImImagePaths(
                text,
                effectiveGroup.folder,
              );

              // ── Complete Feishu streaming card ──
              // If a streaming card is active, finalize it with the complete text.
              // The card replaces the normal IM sendMessage for the Feishu channel.
              let streamingCardHandledIM = false;
              if (streamingSession?.isActive()) {
                try {
                  await streamingSession.complete(text);
                  streamingCardHandledIM = true;
                  // Streaming card replaced the normal sendMessage path,
                  // so clear the ack reaction that would normally be cleared in sendMessage.
                  imManager.clearAckReaction(chatJid);
                  logger.debug(
                    { chatJid },
                    'Streaming card completed with final text',
                  );
                } catch (err) {
                  logger.warn(
                    { err, chatJid },
                    'Streaming card complete failed, falling back to static message',
                  );
                  // Abort the card so it doesn't stay stuck in "streaming" state
                  await streamingSession
                    .abort('回复已通过消息发送')
                    .catch(() => {});
                  // Fall through to normal sendMessage
                }
              }

              // ── Rebuild streaming card after compact_partial / overflow_partial ──
              // The completed card was consumed; create a new one so post-compaction
              // tool-call progress remains visible on Feishu (#223).
              if (
                streamingCardHandledIM &&
                (result.sourceKind === 'compact_partial' ||
                  result.sourceKind === 'overflow_partial')
              ) {
                unregisterStreamingSession(streamingSessionJid);
                streamingAccumulatedText = '';
                streamingAccumulatedThinking = '';
                streamingSession = imManager.createStreamingSession(
                  streamingSessionJid,
                  makeOnCardCreated(streamingSessionJid),
                );
                if (streamingSession) {
                  registerStreamingSession(
                    streamingSessionJid,
                    streamingSession,
                  );
                  logger.debug(
                    { chatJid, sourceKind: result.sourceKind },
                    'Rebuilt streaming card after partial output',
                  );
                }
              }

              // Skip IM send to the original chatJid when:
              // 1. Streaming card already handled the IM delivery, OR
              // 2. Reply route switched to a different IM channel (the routed IM
              //    path below will deliver to the correct channel instead), OR
              // 3. Reply route was cleared to null (web message injected into an
              //    IM-originated session — replies should go to web only).
              // Any send_message content is delivered independently via IPC watcher.
              const routeCleared = directImReply && replySourceImJid === null;
              const routeSwitchedAway =
                directImReply &&
                replySourceImJid !== null &&
                replySourceImJid !== chatJid;
              const skipImSend =
                (streamingCardHandledIM && directImReply) ||
                routeSwitchedAway ||
                routeCleared;
              // When the container stays alive and processes multiple IPC messages,
              // result.turnId stays the same (set at container start).  If we already
              // saved a reply with this turnId, the INSERT OR REPLACE would overwrite
              // the previous reply.  Use a fresh ID to prevent that.
              const effectiveTurnId = result.turnId || lastProcessed.id;
              const turnIdForDb =
                sentReply && effectiveTurnId === lastSavedTurnId
                  ? undefined // no turnId → fresh INSERT, no UPSERT dedup
                  : effectiveTurnId;

              lastReplyMsgId = await sendMessage(chatJid, text, {
                sendToIM: directImReply && !skipImSend,
                localImagePaths,
                messageMeta: {
                  turnId: turnIdForDb,
                  sessionId: result.sessionId || activeSessionId,
                  sdkMessageUuid: result.sdkMessageUuid,
                  sourceKind: result.sourceKind || 'sdk_final',
                  finalizationReason: result.finalizationReason || 'completed',
                },
              });
              lastSavedTurnId = effectiveTurnId;

              // For routed IM (web JID with IM source), only send the FIRST
              // substantive reply to IM. Subsequent results (e.g., SDK Task
              // completions) are stored in DB but not spammed to IM.
              // Streaming card already handles IM delivery for the first reply.
              if (replySourceImJid && replySourceImJid !== chatJid) {
                if (!streamingCardHandledIM && !sentReply) {
                  sendImWithFailTracking(
                    replySourceImJid,
                    text,
                    localImagePaths,
                  );
                }
              }

              // Optional mirror mode for explicitly bound IM channels
              const webJid = chatJid.startsWith('web:')
                ? chatJid
                : `web:${effectiveGroup.folder}`;
              for (const [imJid, g] of Object.entries(registeredGroups)) {
                if (
                  g.target_main_jid !== webJid ||
                  imJid === chatJid ||
                  imJid === replySourceImJid
                )
                  continue;
                if (g.reply_policy !== 'mirror') continue;
                if (getChannelType(imJid))
                  sendImWithFailTracking(imJid, text, localImagePaths);
              }

              sentReply = true;
              // Clear streaming snapshot so the next turn starts fresh.
              // Without this, saveInterruptedStreamingMessages() would merge
              // text from multiple turns into one message on shutdown.
              clearStreamingSnapshot(chatJid);
              streamingAccumulatedText = '';
              streamingAccumulatedThinking = '';
              // Persist cursor as soon as a visible reply is emitted.
              // Long-lived runners may stay alive for idleTimeout, and waiting
              // until process exit would cause duplicate replay after restart.
              commitCursor();
            }
            // Only reset idle timer on actual results, not session-update markers (result: null)
            resetIdleTimer();
          }

          if (result.status === 'error') {
            hadError = true;
            if (result.error) lastError = result.error;
          }
        } catch (err) {
          logger.error({ group: group.name, err }, 'onOutput callback failed');
          hadError = true;
        }
      },
      imagesForAgent,
    );
  } finally {
    await setTyping(chatJid, false);
    // Always clear ack reaction in finally — covers error/interrupt/abort paths
    // where the normal sendMessage (which clears it) is never called.
    imManager.clearAckReaction(chatJid);
    if (idleTimer) clearTimeout(idleTimer);
    activeRouteUpdaters.delete(effectiveGroup.folder);
    clearActiveImReplyRoute(effectiveGroup.folder);

    // ── 检测中断：有累积文本但从未发送回复 ──
    const wasInterrupted = streamInterrupted && !sentReply;

    // ── Streaming card cleanup ──
    if (streamingSession) {
      if (streamingSession.isActive()) {
        if (hadError || !output || output.status === 'error') {
          await streamingSession.abort('处理出错').catch(() => {});
        } else if (wasInterrupted) {
          await streamingSession.abort('已中断').catch(() => {});
        } else {
          streamingSession.dispose();
        }
      }
      unregisterStreamingSession(streamingSessionJid);
    }

    // ── 保存中断内容到数据库 + 广播到 Web ──
    // Skip if the shutdown handler already saved this streaming text (prevents duplicates).
    const webJidForShutdownCheck = chatJid.startsWith('web:')
      ? chatJid
      : `web:${effectiveGroup.folder}`;
    const alreadySavedByShutdown =
      shutdownSavedJids.has(chatJid) ||
      shutdownSavedJids.has(webJidForShutdownCheck);

    if (wasInterrupted && !alreadySavedByShutdown) {
      const interruptedText = buildInterruptedReply(
        streamingAccumulatedText,
        streamingAccumulatedThinking,
      );
      try {
        // sendToIM: false — 飞书卡片已通过 abort() 展示内容，不重复发送
        lastReplyMsgId = await sendMessage(chatJid, interruptedText, {
          sendToIM: false,
          messageMeta: {
            turnId: lastProcessed.id,
            sessionId: activeSessionId,
            sourceKind: 'interrupt_partial',
            finalizationReason: 'interrupted',
          },
        });
        sentReply = true;
        commitCursor();
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to save interrupted text');
      }
    }

    // ── 兜底：进程异常退出导致累积文本未持久化 ──
    // 使用 buildInterruptedReply 而非 buildOverflowPartialReply：
    // 进程被杀（SIGTERM/错误）后不会自动继续，"上下文压缩中"提示会误导用户。
    if (
      !sentReply &&
      !alreadySavedByShutdown &&
      output?.status !== 'closed' &&
      streamingAccumulatedText.trim()
    ) {
      try {
        const partialReply = buildInterruptedReply(
          streamingAccumulatedText,
          streamingAccumulatedThinking,
        );
        lastReplyMsgId = await sendMessage(chatJid, partialReply, {
          sendToIM: false,
          messageMeta: {
            turnId: lastProcessed.id,
            sessionId: activeSessionId,
            sourceKind: 'interrupt_partial',
            finalizationReason: 'error',
          },
        });
        sentReply = true;
        commitCursor();
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to save overflow partial text');
      }
    }
  }

  // runAgent threw — output is undefined, cannot proceed with post-processing.
  // If a reply was already sent, commit the cursor so we don't re-process.
  // Otherwise return false to allow retry (H-1 audit fix).
  if (!output) {
    if (sentReply) {
      commitCursor();
      return true;
    }
    return false;
  }

  // 不可恢复的转录错误（如超大图片/MIME 错配被固化在会话历史中）：无论是否已有回复，都必须重置会话
  const errorForReset = [lastError, output.error].filter(Boolean).join(' ');
  if (
    (output.status === 'error' || hadError) &&
    errorForReset.includes('unrecoverable_transcript:')
  ) {
    const detail = (lastError || output.error || '').replace(
      /.*unrecoverable_transcript:\s*/,
      '',
    );
    logger.warn(
      { group: group.name, folder: group.folder, error: detail },
      'Unrecoverable transcript error, auto-resetting session',
    );

    // 清除会话文件（保留 settings.json）
    await clearSessionRuntimeFiles(group.folder);

    // 清除当前主会话（保留同 folder 下独立 agent 会话）
    try {
      deleteSession(group.folder);
      delete sessions[group.folder];
    } catch (err) {
      logger.error(
        { folder: group.folder, err },
        'Failed to clear session state during auto-reset',
      );
    }

    sendSystemMessage(chatJid, 'context_reset', `会话已自动重置：${detail}`);
    commitCursor();
    return true;
  }

  // Container closed during query (e.g. home folder drain) without sending a reply:
  // don't commit cursor so the message gets retried on the next poll cycle.
  // If sentReply is true the cursor was already committed at line 722, no action needed.
  if (output.status === 'closed' && !sentReply) {
    logger.warn(
      { group: group.name, chatJid },
      'Container closed during query without reply, keeping cursor for retry',
    );
    return true;
  }

  // Query 出错时，将残留 running task 标记为 error，避免长期僵尸状态。
  // 正常退出不做强制 completed，避免把未确认完成的任务误判为已完成。
  const isErrorExit = output.status === 'error' || hadError;
  if (isErrorExit) {
    try {
      // 先获取 running agents（广播需要 agent 详情），再批量标记 error
      const runningAgents = getRunningTaskAgentsByChat(chatJid);
      const marked = markRunningTaskAgentsAsError(chatJid);
      if (marked > 0) {
        logger.info(
          { chatJid, marked },
          'Marked remaining running task agents as error',
        );
        for (const agent of runningAgents) {
          broadcastAgentStatus(
            chatJid,
            agent.id,
            'error',
            agent.name,
            agent.prompt,
            '容器超时或异常退出',
            agent.kind,
          );
        }
      }
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to mark running task agents');
    }
  } else {
    // Safety net: if query already ended successfully but some task agents are still
    // running (usually due SDK event ID mismatch), force-complete them to avoid stale tabs.
    try {
      let completed = 0;
      for (const taskId of queryTaskIds) {
        const agent = getAgent(taskId);
        if (
          !agent ||
          agent.kind !== 'task' ||
          agent.chat_jid !== chatJid ||
          agent.status !== 'running'
        )
          continue;
        updateAgentStatus(
          taskId,
          'completed',
          agent.result_summary || '任务已完成',
        );
        broadcastAgentStatus(
          chatJid,
          taskId,
          'completed',
          agent.name,
          agent.prompt,
          agent.result_summary || '任务已完成',
          agent.kind,
        );
        completed += 1;
      }
      if (completed > 0) {
        logger.warn(
          { chatJid, completed },
          'Force-completed stale running task agents after successful query',
        );
      }
    } catch (err) {
      logger.warn(
        { chatJid, err },
        'Failed to force-complete stale running task agents',
      );
    }
  }

  if (isErrorExit && !sentReply) {
    // Only roll back cursor if no reply was sent — if the agent already
    // replied successfully, a subsequent timeout is not a real error and
    // rolling back would cause the same messages to be re-processed,
    // leading to duplicate replies.
    const errorDetail = output.error || lastError || '未知错误';

    // 上下文溢出错误：跳过重试，提交游标，通知用户
    if (errorDetail.startsWith('context_overflow:')) {
      const overflowMsg = errorDetail.replace(/^context_overflow:\s*/, '');
      sendSystemMessage(chatJid, 'context_overflow', overflowMsg);
      logger.warn(
        { group: group.name, error: overflowMsg },
        'Context overflow detected, skipping retry',
      );
      commitCursor();
      return true;
    }

    // ── OOM auto-recovery: detect consecutive exit code 137 (OOM) ──
    // Only match `code 137` (Docker cgroup OOM killer), not `signal SIGKILL`
    // which is ambiguous for host processes (could be user stop, process tree
    // kill, or actual OOM).  exitLabel is either `code N` or `signal X` —
    // never both — so this only triggers on Docker container OOM exits.
    const isOom = OOM_EXIT_RE.test(errorDetail);
    if (isOom) {
      const folder = effectiveGroup.folder;
      consecutiveOomExits[folder] = (consecutiveOomExits[folder] || 0) + 1;
      setRouterState(
        `oom_exits:${folder}`,
        String(consecutiveOomExits[folder]),
      );
      logger.warn(
        {
          folder,
          consecutive: consecutiveOomExits[folder],
          threshold: OOM_AUTO_RESET_THRESHOLD,
        },
        'OOM exit detected (code 137)',
      );

      if (consecutiveOomExits[folder] >= OOM_AUTO_RESET_THRESHOLD) {
        logger.warn(
          { folder, consecutive: consecutiveOomExits[folder] },
          'Consecutive OOM threshold reached, auto-resetting session to break death loop',
        );
        consecutiveOomExits[folder] = 0;
        deleteRouterState(`oom_exits:${folder}`);

        // Clear session files and DB records (same as unrecoverable_transcript handling)
        try {
          await clearSessionRuntimeFiles(folder);
        } catch (err) {
          logger.error(
            { folder, err },
            'Failed to clear session files during OOM auto-reset',
          );
        }
        try {
          deleteSession(folder);
          delete sessions[folder];
        } catch (err) {
          logger.error(
            { folder, err },
            'Failed to clear session during OOM auto-reset',
          );
        }

        sendSystemMessage(
          chatJid,
          'context_reset',
          '会话文件过大导致内存溢出（OOM），已自动重置会话。之前的对话上下文已清除，请重新描述您的需求。',
        );
        commitCursor();
        return true;
      }
    } else if (consecutiveOomExits[effectiveGroup.folder]) {
      // Non-OOM error: reset the consecutive counter only if it was set
      delete consecutiveOomExits[effectiveGroup.folder];
      deleteRouterState(`oom_exits:${effectiveGroup.folder}`);
    }

    sendSystemMessage(chatJid, 'agent_error', errorDetail);
    logger.warn(
      { group: group.name, error: errorDetail },
      'Agent error (no reply sent), keeping cursor at previous position for retry',
    );
    return false;
  }

  // Reset OOM counter on successful exit (only write DB if counter was set)
  if (consecutiveOomExits[effectiveGroup.folder]) {
    delete consecutiveOomExits[effectiveGroup.folder];
    deleteRouterState(`oom_exits:${effectiveGroup.folder}`);
  }

  // Final fallback for silent-success paths (no visible reply).
  commitCursor();

  return true;
}

async function runTerminalWarmup(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;
  if ((group.executionMode || 'container') === 'host') return;

  logger.info({ chatJid, group: group.name }, 'Starting terminal warmup run');

  const warmupReadyToken = '<terminal_ready>';
  const warmupPrompt = [
    '这是系统触发的终端预热请求。',
    `请只回复 ${warmupReadyToken}，不要回复其它内容，也不要调用工具。`,
  ].join(' ');

  let bootstrapCompleted = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { chatJid, group: group.name },
        'Terminal warmup idle timeout, closing stdin',
      );
      queue.closeStdin(chatJid);
    }, getSystemSettings().idleTimeout);
  };

  try {
    const output = await runAgent(
      group,
      warmupPrompt,
      chatJid,
      undefined,
      async (result) => {
        if (result.status === 'stream' && result.streamEvent) {
          broadcastStreamEvent(chatJid, result.streamEvent);
          return;
        }

        if (result.status === 'error') return;

        // During warmup query, NEVER emit assistant text to chat.
        // Only mark bootstrap complete after the session update marker.
        if (result.result === null) {
          if (!bootstrapCompleted) {
            bootstrapCompleted = true;
            resetIdleTimer();
          }
          return;
        }

        if (!bootstrapCompleted) return;

        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = stripAgentInternalTags(raw);
        if (!text || text === warmupReadyToken) return;
        await sendMessage(chatJid, text);
        resetIdleTimer();
      },
    );

    if (output.status === 'error') {
      logger.warn(
        { chatJid, group: group.name, error: output.error },
        'Terminal warmup run ended with error',
      );
    } else {
      logger.info(
        { chatJid, group: group.name },
        'Terminal warmup run completed',
      );
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function ensureTerminalContainerStarted(chatJid: string): boolean {
  const group = registeredGroups[chatJid];
  if (!group) return false;
  if ((group.executionMode || 'container') === 'host') return false;

  const status = queue.getStatus();
  const groupStatus = status.groups.find((g) => g.jid === chatJid);
  if (groupStatus?.active) return true;
  if (terminalWarmupInFlight.has(chatJid)) return true;

  terminalWarmupInFlight.add(chatJid);
  const taskId = `terminal-warmup:${chatJid}`;
  queue.enqueueTask(chatJid, taskId, async () => {
    try {
      await runTerminalWarmup(chatJid);
    } finally {
      terminalWarmupInFlight.delete(chatJid);
    }
  });
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  turnId?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<{ status: 'success' | 'error' | 'closed'; error?: string }> {
  const isHome = !!group.is_home;
  // For the agent-runner: isMain means this is an admin home container (full privileges)
  const isAdminHome = isHome && group.folder === MAIN_GROUP_FOLDER;
  const runtime = getEffectiveRuntime(group);
  const sessionRecord = sessions[group.folder];
  const sessionId =
    sessionRecord && sessionRecord.runtime === runtime
      ? sessionRecord.sessionId
      : undefined;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isAdminHome,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (admin home only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isAdminHome,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        queue.markRunnerActivity(chatJid);
        if (
          (output.status === 'success' && output.result !== null) ||
          (output.status === 'stream' &&
            output.streamEvent?.eventType === 'status' &&
            output.streamEvent.statusText === 'interrupted')
        ) {
          queue.markRunnerQueryIdle(chatJid);
        }
        // 仅从成功的输出中更新 session ID；
        // error 输出可能携带 stale ID，会覆盖流式传递的有效 session
        if (output.newSessionId && output.status !== 'error') {
          const nextSession = {
            sessionId: output.newSessionId,
            runtime,
          } satisfies RuntimeSessionRecord;
          sessions[group.folder] = nextSession;
          setSession(group.folder, output.newSessionId, undefined, runtime);
        }
        await onOutput(output);
      }
    : undefined;

  ipcWatcherManager?.watchGroup(group.folder);
  try {
    const executionMode = group.executionMode || 'container';

    const onProcessCb = (proc: ChildProcess, identifier: string) => {
      // 宿主机模式：containerName 传 null，走 process.kill() 路径
      const containerName = executionMode === 'container' ? identifier : null;
      queue.registerProcess(
        chatJid,
        proc,
        containerName,
        group.folder,
        identifier,
      );
    };

    const ownerHomeFolder = resolveOwnerHomeFolder(group);

    let output: ContainerOutput;

    if (executionMode === 'host') {
      output = await runHostAgent(
        group,
        {
          prompt,
          sessionId,
          runtime,
          turnId,
          groupFolder: group.folder,
          chatJid,
          isMain: isAdminHome,
          isHome,
          isAdminHome,
          images,
        },
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    } else {
      output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          runtime,
          turnId,
          groupFolder: group.folder,
          chatJid,
          isMain: isAdminHome,
          isHome,
          isAdminHome,
          images,
        },
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    }

    // 仅从成功的最终输出中更新 session ID；
    // error 状态的输出可能携带 stale ID，覆盖流式阶段已写入的有效 session
    if (output.newSessionId && output.status !== 'error') {
      const nextSession = {
        sessionId: output.newSessionId,
        runtime,
      } satisfies RuntimeSessionRecord;
      sessions[group.folder] = nextSession;
      setSession(group.folder, output.newSessionId, undefined, runtime);
    }

    // Agent was interrupted by _close sentinel (home folder drain).
    // Propagate so processGroupMessages can skip cursor commit.
    if (output.status === 'closed') {
      return { status: 'closed' };
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Agent error');
      if (output.result && wrappedOnOutput) {
        try {
          await wrappedOnOutput(output);
        } catch (err) {
          logger.error(
            { group: group.name, err },
            'Failed to emit agent error output',
          );
        }
      }
      return { status: 'error', error: output.error };
    }

    return { status: 'success' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', error: errorMsg };
  } finally {
    ipcWatcherManager?.unwatchGroup(group.folder);
  }
}

async function sendMessage(
  jid: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<string | undefined> {
  const isIMChannel = getChannelType(jid) !== null;
  const sendToIM = options.sendToIM ?? isIMChannel;
  try {
    if (sendToIM && isIMChannel) {
      try {
        const localImagePaths =
          options.localImagePaths ??
          extractLocalImImagePaths(text, resolveEffectiveFolder(jid));
        await imManager.sendMessage(jid, text, localImagePaths);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send message to IM channel');
      }
    }

    // Persist assistant reply so Web polling can render it and clear waiting state.
    const msgId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    ensureChatExists(jid);
    const persistedMsgId = storeMessageDirect(
      msgId,
      jid,
      'happypaw-agent',
      ASSISTANT_NAME,
      text,
      timestamp,
      true,
      { meta: options.messageMeta },
    );

    broadcastNewMessage(
      jid,
      {
        id: persistedMsgId,
        chat_jid: jid,
        sender: 'happypaw-agent',
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp,
        is_from_me: true,
        turn_id: options.messageMeta?.turnId ?? null,
        session_id: options.messageMeta?.sessionId ?? null,
        sdk_message_uuid: options.messageMeta?.sdkMessageUuid ?? null,
        source_kind: options.messageMeta?.sourceKind ?? null,
        finalization_reason: options.messageMeta?.finalizationReason ?? null,
      },
      undefined,
      options.source,
    );
    logger.info({ jid, length: text.length, sendToIM }, 'Message sent');
    // Skip agent_reply broadcast for scheduled tasks to avoid clearing
    // streaming state of a concurrently running main agent.
    // Safe because scheduled tasks never trigger typing indicators, so there's
    // no typing state to clear. The message is still delivered via new_message.
    if (!options.source) {
      broadcastToWebClients(jid, text);
    }
    return persistedMsgId;
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
    return undefined;
  }
}

/**
 * Check if a source group is authorized to send IPC messages to a target group.
 * - Admin home can send to any group.
 * - Non-home groups can only send to groups sharing the same folder.
 * - Member home groups can send to groups created by the same user.
 */
function canSendCrossGroupMessage(
  isAdminHome: boolean,
  isHome: boolean,
  sourceFolder: string,
  sourceGroupEntry: RegisteredGroup | undefined,
  targetGroup: RegisteredGroup | undefined,
): boolean {
  if (isAdminHome) return true;
  if (targetGroup && targetGroup.folder === sourceFolder) return true;
  if (
    isHome &&
    targetGroup &&
    sourceGroupEntry?.created_by != null &&
    targetGroup.created_by === sourceGroupEntry.created_by
  )
    return true;
  return false;
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const fsp = fs.promises;

  /**
   * Broadcast a message to all connected IM channels of a user that haven't
   * already received it. Used by scheduled tasks to fan out to all IM channels.
   */
  function broadcastToOwnerIMChannels(
    userId: string,
    sourceFolder: string,
    alreadySentJids: Set<string>,
    sendFn: (jid: string) => void,
    notifyChannels?: string[] | null,
  ): void {
    const sentChannelTypes = new Set<string>();
    for (const jid of alreadySentJids) {
      const ct = getChannelType(jid);
      if (ct) sentChannelTypes.add(ct);
    }
    const connectedTypes = imManager.getConnectedChannelTypes(userId);
    const ownerGroups = getGroupsByOwner(userId);
    for (const channelType of connectedTypes) {
      if (sentChannelTypes.has(channelType)) continue;
      // Filter by notify_channels if specified (null = all channels)
      if (notifyChannels && !notifyChannels.includes(channelType)) continue;
      const target = ownerGroups.find(
        (g) =>
          getChannelType(g.jid) === channelType && g.folder === sourceFolder,
      );
      if (target) {
        sendFn(target.jid);
        sentChannelTypes.add(channelType);
      }
    }
  }

  const processGroupIpc = async (sourceGroup: string) => {
    if (shuttingDown) return;
    // Determine if this IPC directory belongs to an admin home group
    const sourceGroupEntry = Object.values(registeredGroups).find(
      (g) => g.folder === sourceGroup,
    );
    const isAdminHome = !!(
      sourceGroupEntry?.is_home && sourceGroup === MAIN_GROUP_FOLDER
    );
    const isHome = !!sourceGroupEntry?.is_home;

    // Collect all IPC roots: main group dir + agents/*/ + tasks-run/*/
    // Tag agent roots with their agentId so we can route messages to virtual JIDs.
    const groupIpcRoot = path.join(ipcBaseDir, sourceGroup);
    const ipcRoots: Array<{
      path: string;
      agentId: string | null;
      taskId: string | null;
    }> = [{ path: groupIpcRoot, agentId: null, taskId: null }];
    try {
      const agentsDir = path.join(groupIpcRoot, 'agents');
      const agentEntries = await fsp.readdir(agentsDir, {
        withFileTypes: true,
      });
      for (const entry of agentEntries) {
        if (entry.isDirectory()) {
          ipcRoots.push({
            path: path.join(agentsDir, entry.name),
            agentId: entry.name,
            taskId: null,
          });
        }
      }
    } catch {
      /* agents dir may not exist */
    }
    try {
      const tasksRunDir = path.join(groupIpcRoot, 'tasks-run');
      const taskRunEntries = await fsp.readdir(tasksRunDir, {
        withFileTypes: true,
      });
      for (const entry of taskRunEntries) {
        if (entry.isDirectory()) {
          ipcRoots.push({
            path: path.join(tasksRunDir, entry.name),
            agentId: null,
            taskId: entry.name,
          });
        }
      }
    } catch {
      /* tasks-run dir may not exist */
    }

    for (const {
      path: ipcRoot,
      agentId: ipcAgentId,
      taskId: ipcTaskId,
    } of ipcRoots) {
      const messagesDir = path.join(ipcRoot, 'messages');
      const tasksDir = path.join(ipcRoot, 'tasks');

      // Process messages from this group's IPC directory
      try {
        const messageEntries = await fsp.readdir(messagesDir);
        const messageFiles = messageEntries.filter((f) => f.endsWith('.json'));
        for (const file of messageFiles) {
          const filePath = path.join(messagesDir, file);
          try {
            const raw = await fsp.readFile(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.type === 'message' && data.chatJid && data.text) {
              const targetGroup = registeredGroups[data.chatJid];
              if (
                canSendCrossGroupMessage(
                  isAdminHome,
                  isHome,
                  sourceGroup,
                  sourceGroupEntry,
                  targetGroup,
                )
              ) {
                // Conversation agents: route to virtual JID so message appears
                // in the agent tab, not the main conversation.
                const effectiveChatJid = ipcAgentId
                  ? `${data.chatJid}#agent:${ipcAgentId}`
                  : data.chatJid;
                await sendMessage(effectiveChatJid, data.text, {
                  messageMeta: {
                    sourceKind: 'sdk_send_message',
                  },
                });

                // Forward to IM channel — but NOT for conversation agent messages.
                // Conversation agents handle their own IM routing in
                // processAgentConversation's wrappedOnOutput callback.
                if (!ipcAgentId) {
                  const ipcImRoute = activeImReplyRoutes.get(sourceGroup);
                  if (
                    ipcImRoute &&
                    getChannelType(data.chatJid) === null &&
                    ipcImRoute !== data.chatJid
                  ) {
                    const localImages = extractLocalImImagePaths(
                      data.text,
                      sourceGroup,
                    );
                    sendImWithFailTracking(ipcImRoute, data.text, localImages);
                  }

                  // Scheduled task: broadcast to all connected IM channels of the owner
                  if (data.isScheduledTask && sourceGroupEntry?.created_by) {
                    const alreadySent = new Set<string>(
                      [data.chatJid, ipcImRoute].filter(Boolean) as string[],
                    );
                    const taskLocalImages = extractLocalImImagePaths(
                      data.text,
                      sourceGroup,
                    );
                    // Resolve notify_channels from the task
                    let taskNotifyChannels: string[] | null | undefined;
                    if (ipcTaskId) {
                      const taskRecord = getTaskById(ipcTaskId);
                      taskNotifyChannels = taskRecord?.notify_channels;
                    }
                    broadcastToOwnerIMChannels(
                      sourceGroupEntry.created_by,
                      sourceGroup,
                      alreadySent,
                      (jid) =>
                        sendImWithFailTracking(jid, data.text, taskLocalImages),
                      taskNotifyChannels,
                    );
                  }
                }
                logger.info(
                  {
                    chatJid: effectiveChatJid,
                    sourceGroup,
                    agentId: ipcAgentId,
                  },
                  'IPC message sent',
                );
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup },
                  'Unauthorized IPC message attempt blocked',
                );
              }
            } else if (
              data.type === 'image' &&
              data.chatJid &&
              data.imageBase64
            ) {
              // Handle image IPC messages from send_image MCP tool
              const targetGroup = registeredGroups[data.chatJid];
              if (
                canSendCrossGroupMessage(
                  isAdminHome,
                  isHome,
                  sourceGroup,
                  sourceGroupEntry,
                  targetGroup,
                )
              ) {
                try {
                  const imageBuffer = Buffer.from(data.imageBase64, 'base64');
                  const mimeType = data.mimeType || 'image/png';
                  const caption = data.caption || undefined;
                  const fileName = data.fileName || undefined;

                  // Conversation agents: skip IM forwarding (handled in wrappedOnOutput).
                  // Non-agent: route to IM via activeImReplyRoutes.
                  const imgImRoute = ipcAgentId
                    ? null
                    : getChannelType(data.chatJid) !== null
                      ? data.chatJid
                      : (activeImReplyRoutes.get(sourceGroup) ?? null);
                  if (imgImRoute) {
                    await retryImOperation('send_image', imgImRoute, () =>
                      imManager.sendImage(
                        imgImRoute,
                        imageBuffer,
                        mimeType,
                        caption,
                        fileName,
                      ),
                    );
                  }

                  // Conversation agents: store in virtual JID (agent tab).
                  const imgChatJid = ipcAgentId
                    ? `${data.chatJid}#agent:${ipcAgentId}`
                    : data.chatJid;

                  // Persist image message to DB and broadcast to WebSocket (same as sendMessage flow)
                  const displayText = caption
                    ? `[图片: ${fileName || 'image'}]\n${caption}`
                    : `[图片: ${fileName || 'image'}]`;
                  const imgMsgId = crypto.randomUUID();
                  const imgTimestamp = new Date().toISOString();
                  ensureChatExists(imgChatJid);
                  const persistedImgMsgId = storeMessageDirect(
                    imgMsgId,
                    imgChatJid,
                    'happypaw-agent',
                    ASSISTANT_NAME,
                    displayText,
                    imgTimestamp,
                    true,
                    { meta: { sourceKind: 'sdk_send_message' } },
                  );
                  broadcastNewMessage(imgChatJid, {
                    id: persistedImgMsgId,
                    chat_jid: imgChatJid,
                    sender: 'happypaw-agent',
                    sender_name: ASSISTANT_NAME,
                    content: displayText,
                    timestamp: imgTimestamp,
                    is_from_me: true,
                    turn_id: null,
                    session_id: null,
                    sdk_message_uuid: null,
                    source_kind: 'sdk_send_message',
                    finalization_reason: null,
                  });
                  broadcastToWebClients(imgChatJid, displayText);

                  // Scheduled task: broadcast image to all connected IM channels
                  // (not applicable for agent IPC)
                  if (
                    !ipcAgentId &&
                    data.isScheduledTask &&
                    sourceGroupEntry?.created_by
                  ) {
                    const alreadySent = new Set<string>(
                      [data.chatJid, imgImRoute].filter(Boolean) as string[],
                    );
                    let imgTaskNotifyChannels: string[] | null | undefined;
                    if (ipcTaskId) {
                      const imgTaskRecord = getTaskById(ipcTaskId);
                      imgTaskNotifyChannels = imgTaskRecord?.notify_channels;
                    }
                    broadcastToOwnerIMChannels(
                      sourceGroupEntry.created_by,
                      sourceGroup,
                      alreadySent,
                      (jid) =>
                        imManager
                          .sendImage(
                            jid,
                            imageBuffer,
                            mimeType,
                            caption,
                            fileName,
                          )
                          .catch((err) =>
                            logger.warn(
                              { jid, err },
                              'Failed to broadcast task image to IM',
                            ),
                          ),
                      imgTaskNotifyChannels,
                    );
                  }

                  logger.info(
                    {
                      chatJid: imgChatJid,
                      sourceGroup,
                      mimeType,
                      size: imageBuffer.length,
                      agentId: ipcAgentId,
                    },
                    'IPC image sent',
                  );
                } catch (err) {
                  logger.error(
                    { chatJid: data.chatJid, sourceGroup, err },
                    'Failed to process IPC image',
                  );
                }
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup },
                  'Unauthorized IPC image attempt blocked',
                );
              }
            }
            await fsp.unlink(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC message',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            await fsp.mkdir(errorDir, { recursive: true });
            try {
              await fsp.rename(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            } catch (renameErr) {
              logger.error(
                { file, sourceGroup, renameErr },
                'Failed to move IPC message to error directory, deleting',
              );
              try {
                await fsp.unlink(filePath);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC messages directory',
          );
        }
      }

      // Process tasks from this group's IPC directory
      try {
        const allEntries = await fsp.readdir(tasksDir, {
          withFileTypes: true,
        });

        // 清理孤儿结果文件（容器崩溃或超时后残留，超过 10 分钟自动删除）
        for (const entry of allEntries) {
          if (
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            (entry.name.startsWith('install_skill_result_') ||
              entry.name.startsWith('uninstall_skill_result_') ||
              entry.name.startsWith('list_tasks_result_'))
          ) {
            try {
              const filePath = path.join(tasksDir, entry.name);
              const stat = await fsp.stat(filePath);
              if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
                await fsp.unlink(filePath);
                logger.debug(
                  { sourceGroup, file: entry.name },
                  'Cleaned up stale skill result file',
                );
              }
            } catch {
              /* ignore */
            }
          }
        }

        const taskFiles = allEntries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith('.json') &&
              !entry.name.startsWith('install_skill_result_') &&
              !entry.name.startsWith('uninstall_skill_result_') &&
              !entry.name.startsWith('list_tasks_result_'),
          )
          .map((entry) => entry.name);
        for (const file of taskFiles) {
          const filePath = path.join(tasksDir, file);
          try {
            const raw = await fsp.readFile(filePath, 'utf-8');
            const data = JSON.parse(raw);
            // Pass source group identity to processTaskIpc for authorization
            await processTaskIpc(
              data,
              sourceGroup,
              isAdminHome,
              isHome,
              sourceGroupEntry,
              ipcAgentId,
            );
            await fsp.unlink(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC task',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            await fsp.mkdir(errorDir, { recursive: true });
            try {
              await fsp.rename(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            } catch (renameErr) {
              logger.error(
                { file, sourceGroup, renameErr },
                'Failed to move IPC task to error directory, deleting',
              );
              try {
                await fsp.unlink(filePath);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC tasks directory',
          );
        }
      }
    } // end for (const ipcRoot of ipcRoots)
  };

  const processIpcFilesFull = async () => {
    if (shuttingDown) return;
    let groupFolders: string[];
    try {
      const entries = await fsp.readdir(ipcBaseDir, { withFileTypes: true });
      groupFolders = entries
        .filter((e) => e.isDirectory() && e.name !== 'errors')
        .map((e) => e.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      return;
    }

    for (const sourceGroup of groupFolders) {
      // Route through the concurrency guard to prevent racing with event-driven triggers
      ipcWatcherManager!.triggerProcess(sourceGroup);
    }
  };

  // Initialize the event-driven IPC watcher manager
  ipcWatcherManager = new IpcWatcherManager();
  ipcWatcherManager.bind(processGroupIpc, processIpcFilesFull);

  // Initial full scan
  processIpcFilesFull().catch((err) => {
    logger.error({ err }, 'Error in initial IPC scan');
  });

  // Start fallback polling (5s instead of 1s)
  ipcWatcherManager.startFallback();

  logger.info('IPC watcher started (event-driven + 5s fallback)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    execution_type?: string;
    script_command?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    executionMode?: string;
    // For install_skill / uninstall_skill
    package?: string;
    requestId?: string;
    skillId?: string;
    // For send_file
    filePath?: string;
    fileName?: string;
    // For list_tasks
    isAdminHome?: boolean;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isAdminHome: boolean, // Whether source is admin home container
  isHome: boolean, // Whether source is a home container
  sourceGroupEntry: RegisteredGroup | undefined, // Source group's registered entry
  ipcAgentId: string | null = null, // Non-null when IPC comes from a conversation agent
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      if (data.schedule_type && data.schedule_value && data.targetJid) {
        const execType =
          data.execution_type === 'script'
            ? ('script' as const)
            : ('agent' as const);

        // Script tasks require prompt OR script_command; agent tasks require prompt
        if (execType === 'agent' && !data.prompt) {
          logger.warn('schedule_task: agent mode requires prompt');
          break;
        }
        if (execType === 'script' && !data.script_command) {
          logger.warn('schedule_task: script mode requires script_command');
          break;
        }

        // Only admin home can create script tasks
        if (execType === 'script' && !isAdminHome) {
          logger.warn(
            { sourceGroup },
            'Non-admin container attempted to create script task',
          );
          break;
        }

        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-admin-home groups can only schedule for themselves
        if (!isAdminHome && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt || '',
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          execution_type: execType,
          script_command: data.script_command ?? null,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode, execType },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'list_tasks':
      if (data.requestId) {
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn(
            { sourceGroup, requestId },
            'Rejected list_tasks request with invalid requestId',
          );
          break;
        }
        const listTasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
        const listTasksDirResolved = path.resolve(listTasksDir);
        const resultFileName = `list_tasks_result_${requestId}.json`;
        const resultFilePath = path.resolve(listTasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${listTasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected list_tasks request with unsafe result file path',
          );
          break;
        }

        fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
        try {
          const allTasks = getAllTasks();
          // Admin home sees all tasks, others only see their own group's tasks
          const filteredTasks = isAdminHome
            ? allTasks
            : allTasks.filter((t) => t.group_folder === sourceGroup);
          const taskList = filteredTasks.map((t) => ({
            id: t.id,
            groupFolder: t.group_folder,
            prompt: t.prompt,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
          }));
          const resultData = JSON.stringify({ success: true, tasks: taskList });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.writeFileSync(tmpPath, resultData);
          fs.renameSync(tmpPath, resultFilePath);
          logger.debug(
            { sourceGroup, taskCount: taskList.length },
            'Task list sent via IPC',
          );
        } catch (err) {
          const errorResult = JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          logger.error({ sourceGroup, err }, 'Failed to list tasks via IPC');
        }
      }
      break;

    case 'refresh_groups':
      // Only admin home group can request a refresh
      if (isAdminHome) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only admin home group can register new groups
      if (!isAdminHome) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder) {
        // Inherit created_by from the source group so onNewChat won't re-route
        const sourceEntry = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const execMode =
          data.executionMode === 'host' || data.executionMode === 'container'
            ? data.executionMode
            : undefined;
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          created_by: sourceEntry?.created_by,
          executionMode: execMode,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'install_skill':
      if (data.package && data.requestId) {
        const pkg = data.package;
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn(
            { sourceGroup, requestId },
            'Rejected install_skill request with invalid requestId',
          );
          break;
        }
        const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
        const tasksDirResolved = path.resolve(tasksDir);
        const resultFileName = `install_skill_result_${requestId}.json`;
        const resultFilePath = path.resolve(tasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected install_skill request with unsafe result file path',
          );
          break;
        }

        // Find the user who owns this group
        const sourceGroupForSkill = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const userId = sourceGroupForSkill?.created_by;

        if (!userId) {
          logger.warn(
            { sourceGroup },
            'Cannot install skill: no user associated with group',
          );
          const errorResult = JSON.stringify({
            success: false,
            error: 'No user associated with this group',
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          break;
        }

        try {
          const result = await installSkillForUser(userId, pkg);
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, JSON.stringify(result));
          fs.renameSync(tmpPath, resultFilePath);
          logger.info(
            { sourceGroup, userId, pkg, success: result.success },
            'Skill installation via IPC completed',
          );
        } catch (err) {
          const errorResult = JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          logger.error(
            { sourceGroup, userId, pkg, err },
            'Skill installation via IPC failed',
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid install_skill request - missing required fields',
        );
      }
      break;

    case 'uninstall_skill':
      if (data.skillId && data.requestId) {
        const skillId = data.skillId;
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn(
            { sourceGroup, requestId },
            'Rejected uninstall_skill request with invalid requestId',
          );
          break;
        }
        const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
        const tasksDirResolved = path.resolve(tasksDir);
        const resultFileName = `uninstall_skill_result_${requestId}.json`;
        const resultFilePath = path.resolve(tasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected uninstall_skill request with unsafe result file path',
          );
          break;
        }

        const sourceGroupForUninstall = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const userId = sourceGroupForUninstall?.created_by;

        if (!userId) {
          logger.warn(
            { sourceGroup },
            'Cannot uninstall skill: no user associated with group',
          );
          const errorResult = JSON.stringify({
            success: false,
            error: 'No user associated with this group',
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          break;
        }

        const result = deleteSkillForUser(userId, skillId);
        const tmpPath = `${resultFilePath}.tmp`;
        fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(result));
        fs.renameSync(tmpPath, resultFilePath);
        logger.info(
          { sourceGroup, userId, skillId, success: result.success },
          'Skill uninstall via IPC completed',
        );
      } else {
        logger.warn(
          { data },
          'Invalid uninstall_skill request - missing required fields',
        );
      }
      break;

    case 'send_file':
      if (data.chatJid && data.filePath && data.fileName) {
        // Cross-group authorization check (same as send_message)
        const targetGroup = registeredGroups[data.chatJid];
        if (
          !canSendCrossGroupMessage(
            isAdminHome,
            isHome,
            sourceGroup,
            sourceGroupEntry,
            targetGroup,
          )
        ) {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized IPC send_file attempt blocked',
          );
          break;
        }

        try {
          // Resolve to workspace path - IPC sends relative paths from workspace/group
          const fullPath = path.join(GROUPS_DIR, sourceGroup, data.filePath);

          // Path traversal protection: ensure resolved path stays within workspace
          const resolvedPath = path.resolve(fullPath);
          const safeRoot = path.resolve(GROUPS_DIR, sourceGroup) + path.sep;
          if (!resolvedPath.startsWith(safeRoot)) {
            logger.warn(
              { sourceGroup, filePath: data.filePath, resolvedPath },
              'Path traversal attempt blocked in send_file IPC',
            );
            break;
          }

          // Route to IM: skip for conversation agents (they handle their own IM).
          const fileImRoute = ipcAgentId
            ? null
            : getChannelType(data.chatJid) !== null
              ? data.chatJid
              : (activeImReplyRoutes.get(sourceGroup) ?? null);
          if (fileImRoute) {
            const imFileName = data.fileName || path.basename(resolvedPath);
            await retryImOperation('send_file', fileImRoute, () =>
              imManager.sendFile(fileImRoute, resolvedPath, imFileName),
            );
          } else {
            logger.debug(
              { chatJid: data.chatJid, sourceGroup },
              'No IM route for send_file, skipped IM delivery',
            );
          }
          logger.info(
            {
              sourceGroup,
              chatJid: data.chatJid,
              fileName: data.fileName,
              imRoute: fileImRoute,
            },
            'File sent via IPC',
          );
        } catch (err) {
          logger.error({ err, data }, 'Failed to send file via IPC');
        }
      } else {
        logger.warn(
          { data },
          'Invalid send_file request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Process messages for a user-created conversation agent.
 * Similar to processGroupMessages but uses agent-specific session/IPC and virtual JID.
 * The agent process stays alive for idleTimeout, cycling idle→running.
 */
async function processAgentConversation(
  chatJid: string,
  agentId: string,
): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent || (agent.kind !== 'conversation' && agent.kind !== 'spawn')) {
    logger.warn(
      { chatJid, agentId },
      'processAgentConversation: agent not found or not a conversation/spawn',
    );
    return;
  }

  let group = registeredGroups[chatJid];
  if (!group) {
    Object.keys(registeredGroups).forEach((key) => {
      delete registeredGroups[key];
    });
    Object.assign(registeredGroups, getAllRegisteredGroups());
    group = registeredGroups[chatJid];
  }
  if (!group) return;

  const { effectiveGroup } = resolveEffectiveGroup(group);

  const virtualChatJid = `${chatJid}#agent:${agentId}`;
  const virtualJid = virtualChatJid; // used as queue key

  // Get pending messages
  const sinceCursor = lastAgentTimestamp[virtualChatJid] || EMPTY_CURSOR;
  const missedMessages = getMessagesSince(virtualChatJid, sinceCursor);
  if (missedMessages.length === 0) {
    // Spawn agents are fire-and-forget: if no messages are found (race condition
    // or cursor already advanced), mark as error so they don't stay idle forever.
    if (agent.kind === 'spawn' && agent.status === 'idle') {
      updateAgentStatus(agentId, 'error', '未找到待处理消息');
      broadcastAgentStatus(
        chatJid,
        agentId,
        'error',
        agent.name,
        agent.prompt,
        '未找到待处理消息',
      );
      logger.warn(
        { chatJid, agentId },
        'Spawn agent had no pending messages, marked as error',
      );
    }
    return;
  }

  const isHome = !!effectiveGroup.is_home;
  const isAdminHome = isHome && effectiveGroup.folder === MAIN_GROUP_FOLDER;

  // Update agent status → running
  updateAgentStatus(agentId, 'running');
  broadcastAgentStatus(chatJid, agentId, 'running', agent.name, agent.prompt);

  const prompt = formatMessages(missedMessages, false);
  const images = collectMessageImages(virtualChatJid, missedMessages);
  const imagesForAgent = images.length > 0 ? images : undefined;
  // For agent conversations, route reply to IM based on the most recent
  // message's source.  Unlike the main conversation (#99), agent conversations
  // are explicitly bound to IM groups, so the user expects replies to go back
  // to the IM channel they last messaged from — even if older messages in
  // the batch originated from the web (e.g. after a /clear).
  let replySourceImJid: string | null = null;
  {
    const lastSourceJid = missedMessages[missedMessages.length - 1]?.source_jid;
    if (lastSourceJid && getChannelType(lastSourceJid) !== null) {
      replySourceImJid = lastSourceJid;
    }
  }

  // Fallback: if no IM source in current messages (e.g. web "继续" after
  // restart), recover from the persisted last_im_jid in the DB (#225).
  // Verify the channel is actually connected — stale JIDs from disabled
  // channels would cause unnecessary retries and eventual auto-unbind.
  if (!replySourceImJid) {
    const agentRow = getAgent(agentId);
    if (agentRow?.last_im_jid) {
      if (imManager.isChannelAvailableForJid(agentRow.last_im_jid)) {
        replySourceImJid = agentRow.last_im_jid;
        logger.info(
          { chatJid, agentId, recoveredImJid: replySourceImJid },
          'Recovered IM routing from persisted last_im_jid',
        );
      } else {
        logger.info(
          { chatJid, agentId, staleImJid: agentRow.last_im_jid },
          'Skipped last_im_jid recovery: channel disconnected',
        );
      }
    }
  }

  // Persist the IM routing target so it survives service restarts.
  if (replySourceImJid) {
    updateAgentLastImJid(agentId, replySourceImJid);
  }

  // ── Feishu Streaming Card (conversation agent) ──
  // Unlike processGroupMessages which falls back to chatJid, conversation agents
  // only stream when the message originates from an IM channel (replySourceImJid).
  // Web-only interactions don't need a Feishu streaming card.
  // Use agent-scoped key to avoid colliding with the main session's streaming card (#242).
  const streamingSessionJid = replySourceImJid
    ? `${replySourceImJid}#agent:${agentId}`
    : undefined;
  let agentStreamingSession = replySourceImJid
    ? imManager.createStreamingSession(replySourceImJid, (messageId) =>
        registerMessageIdMapping(messageId, streamingSessionJid!),
      )
    : undefined;
  let agentStreamingAccText = '';
  let agentStreamInterrupted = false;
  if (agentStreamingSession && streamingSessionJid) {
    registerStreamingSession(streamingSessionJid, agentStreamingSession);
    logger.debug(
      { chatJid, agentId },
      'Streaming card session created for conversation agent',
    );
  }

  // Track idle timer
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { agentId, chatJid },
        'Agent conversation idle timeout, closing stdin',
      );
      queue.closeStdin(virtualJid);
    }, getSystemSettings().idleTimeout);
  };

  let cursorCommitted = false;
  let hadError = false;
  let lastError = '';
  let lastAgentReplyMsgId: string | undefined;
  let lastAgentReplyText: string | undefined;
  let output: ContainerOutput | undefined;
  const lastProcessed = missedMessages[missedMessages.length - 1];
  const commitCursor = (): void => {
    if (cursorCommitted) return;
    advanceCursors(virtualChatJid, {
      timestamp: lastProcessed.timestamp,
      id: lastProcessed.id,
    });
    cursorCommitted = true;
  };

  const runtime = getEffectiveRuntime(effectiveGroup);
  const sessionRecord = getRuntimeSession(effectiveGroup.folder, agentId);
  const sessionId =
    sessionRecord && sessionRecord.runtime === runtime
      ? sessionRecord.sessionId
      : undefined;
  let currentAgentSessionId = sessionId;

  const wrappedOnOutput = async (output: ContainerOutput) => {
    // Track session
    if (output.newSessionId && output.status !== 'error') {
      setSession(effectiveGroup.folder, output.newSessionId, agentId, runtime);
      currentAgentSessionId = output.newSessionId;
    }

    // Stream events
    if (output.status === 'stream' && output.streamEvent) {
      broadcastStreamEvent(chatJid, output.streamEvent, agentId);

      // ── 累积 text_delta 文本（中断时用于保存已输出内容）──
      if (
        output.streamEvent.eventType === 'text_delta' &&
        output.streamEvent.text
      ) {
        agentStreamingAccText += output.streamEvent.text;
      }

      // ── Feed stream events into Feishu streaming card ──
      if (agentStreamingSession) {
        feedStreamEventToCard(
          agentStreamingSession,
          output.streamEvent,
          agentStreamingAccText,
        );
      }

      // ── 中断时立即保存已输出内容 ──
      if (
        output.streamEvent.eventType === 'status' &&
        output.streamEvent.statusText === 'interrupted'
      ) {
        agentStreamInterrupted = true;
        if (!cursorCommitted) {
          const interruptedText = buildInterruptedReply(agentStreamingAccText);
          try {
            if (agentStreamingSession?.isActive()) {
              await agentStreamingSession.abort('已中断').catch(() => {});
            }
            const msgId = crypto.randomUUID();
            const timestamp = new Date().toISOString();
            ensureChatExists(virtualChatJid);
            const persistedMsgId = storeMessageDirect(
              msgId,
              virtualChatJid,
              'happypaw-agent',
              ASSISTANT_NAME,
              interruptedText,
              timestamp,
              true,
              {
                meta: {
                  turnId: output.streamEvent.turnId || lastProcessed.id,
                  sessionId:
                    output.streamEvent.sessionId || currentAgentSessionId,
                  sourceKind: 'interrupt_partial',
                  finalizationReason: 'interrupted',
                },
              },
            );
            broadcastNewMessage(
              virtualChatJid,
              {
                id: persistedMsgId,
                chat_jid: virtualChatJid,
                sender: 'happypaw-agent',
                sender_name: ASSISTANT_NAME,
                content: interruptedText,
                timestamp,
                is_from_me: true,
                turn_id: output.streamEvent.turnId || lastProcessed.id,
                session_id:
                  output.streamEvent.sessionId || currentAgentSessionId,
                sdk_message_uuid: null,
                source_kind: 'interrupt_partial',
                finalization_reason: 'interrupted',
              },
              agentId,
            );
            commitCursor();
          } catch (err) {
            logger.warn(
              { err, chatJid, agentId },
              'Failed to save interrupted agent text on status event',
            );
          }
        }
      }

      // Persist token usage for agent conversations
      if (
        output.streamEvent.eventType === 'usage' &&
        output.streamEvent.usage
      ) {
        try {
          updateLatestMessageTokenUsage(
            virtualChatJid,
            JSON.stringify(output.streamEvent.usage),
            lastAgentReplyMsgId,
          );

          // Write to usage_records + usage_daily_summary
          // Sub-Agent 的 effectiveGroup 可能没有 created_by，从父群组继承
          writeUsageRecords({
            userId:
              effectiveGroup.created_by ||
              registeredGroups[chatJid]?.created_by ||
              'system',
            groupFolder: effectiveGroup.folder,
            agentId,
            messageId: lastAgentReplyMsgId,
            usage: output.streamEvent.usage,
          });
        } catch (err) {
          logger.warn(
            { err, chatJid, agentId },
            'Failed to persist agent conversation token usage',
          );
        }
      }

      // Reset idle timer on stream events so long-running tool calls
      // don't get killed while the agent is actively working.
      resetIdleTimer();
      return;
    }

    // Agent reply
    if (output.result) {
      const raw =
        typeof output.result === 'string'
          ? output.result
          : JSON.stringify(output.result);
      let text = stripAgentInternalTags(raw);
      if (
        output.sourceKind === 'overflow_partial' ||
        output.sourceKind === 'compact_partial'
      ) {
        // Spawn agents are fire-and-forget: context compression is an internal
        // detail. Don't append the "上下文压缩中" suffix — it confuses users
        // seeing the Feishu card suddenly change to a warning.
        if (agent.kind !== 'spawn') {
          text = buildOverflowPartialReply(text);
        }
      }
      // Suppress system-maintenance noise from auto_continue outputs (issue #275).
      // Short acknowledgements ("OK", "已更新 CLAUDE.md") that leak from the
      // compaction pipeline are dropped; substantive continuations pass through.
      if (
        output.sourceKind === 'auto_continue' &&
        isSystemMaintenanceNoise(text)
      ) {
        logger.info(
          { chatJid, agentId, textLen: text.length },
          'auto_continue output suppressed (system maintenance noise)',
        );
        return;
      }
      if (text) {
        const isFirstReply = !lastAgentReplyMsgId;
        const msgId = crypto.randomUUID();
        lastAgentReplyMsgId = msgId;
        lastAgentReplyText = text;
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        const persistedMsgId = storeMessageDirect(
          msgId,
          virtualChatJid,
          'happypaw-agent',
          ASSISTANT_NAME,
          text,
          timestamp,
          true,
          {
            meta: {
              turnId: output.turnId || lastProcessed.id,
              sessionId: output.sessionId || currentAgentSessionId,
              sdkMessageUuid: output.sdkMessageUuid,
              sourceKind: output.sourceKind || 'sdk_final',
              finalizationReason: output.finalizationReason || 'completed',
            },
          },
        );
        broadcastNewMessage(
          virtualChatJid,
          {
            id: persistedMsgId,
            chat_jid: virtualChatJid,
            sender: 'happypaw-agent',
            sender_name: ASSISTANT_NAME,
            content: text,
            timestamp,
            is_from_me: true,
            turn_id: output.turnId || lastProcessed.id,
            session_id: output.sessionId || currentAgentSessionId,
            sdk_message_uuid: output.sdkMessageUuid ?? null,
            source_kind: output.sourceKind || 'sdk_final',
            finalization_reason: output.finalizationReason || 'completed',
          },
          agentId,
        );

        const localImagePaths = extractLocalImImagePaths(
          text,
          effectiveGroup.folder,
        );

        // ── Complete Feishu streaming card or fall back to static message ──
        let streamingCardHandledIM = false;
        if (agentStreamingSession?.isActive()) {
          try {
            await agentStreamingSession.complete(text);
            streamingCardHandledIM = true;
          } catch (err) {
            logger.warn(
              { err, chatJid, agentId },
              'Agent streaming card complete failed, falling back to static message',
            );
            await agentStreamingSession
              .abort('回复已通过消息发送')
              .catch(() => {});
          }
        }

        // ── Rebuild streaming card after compact_partial / overflow_partial ──
        // The completed card was consumed; create a new one so post-compaction
        // tool-call progress remains visible on Feishu (#223).
        if (
          streamingCardHandledIM &&
          (output.sourceKind === 'compact_partial' ||
            output.sourceKind === 'overflow_partial') &&
          streamingSessionJid
        ) {
          agentStreamingAccText = '';
          unregisterStreamingSession(streamingSessionJid);
          agentStreamingSession = imManager.createStreamingSession(
            replySourceImJid!,
            (messageId) =>
              registerMessageIdMapping(messageId, streamingSessionJid!),
          );
          if (agentStreamingSession) {
            registerStreamingSession(
              streamingSessionJid,
              agentStreamingSession,
            );
            logger.debug(
              { chatJid, agentId, sourceKind: output.sourceKind },
              'Rebuilt streaming card after partial output',
            );
          }
        }

        if (replySourceImJid && !streamingCardHandledIM && isFirstReply) {
          // Only send the FIRST substantive reply to IM. Subsequent results
          // (SDK Task completions) are stored in DB but not spammed to IM.
          const imSent = await sendImWithRetry(
            replySourceImJid,
            text,
            localImagePaths,
          );
          if (imSent) {
            logger.info(
              {
                chatJid,
                agentId,
                replySourceImJid,
                sourceKind: output.sourceKind,
                textLen: text.length,
              },
              'Agent conversation: static IM message sent',
            );
          } else {
            logger.error(
              {
                chatJid,
                agentId,
                replySourceImJid,
                sourceKind: output.sourceKind,
              },
              'Agent conversation: IM send failed after all retries, message lost',
            );
          }
        } else if (!replySourceImJid) {
          logger.debug(
            { chatJid, agentId, sourceKind: output.sourceKind },
            'Agent conversation: no replySourceImJid, skip IM delivery',
          );
        }

        // Optional mirror mode for linked IM channels
        for (const [imJid, g] of Object.entries(registeredGroups)) {
          if (g.target_agent_id !== agentId || imJid === replySourceImJid)
            continue;
          if (g.reply_policy !== 'mirror') continue;
          if (getChannelType(imJid))
            sendImWithFailTracking(imJid, text, localImagePaths);
        }

        commitCursor();
        resetIdleTimer();

        // Spawn agents are fire-and-forget: close after first reply to free process slot.
        // Skip for overflow_partial/compact_partial — those are intermediate context
        // compression outputs, not the final result; closing now would kill the agent
        // before it finishes the actual task.
        if (
          agent.kind === 'spawn' &&
          text &&
          output.sourceKind !== 'overflow_partial' &&
          output.sourceKind !== 'compact_partial'
        ) {
          logger.info(
            { agentId, chatJid },
            'Spawn agent replied, sending close signal',
          );
          queue.closeStdin(virtualChatJid);
        }
      }
    }

    if (output.status === 'error') {
      hadError = true;
      if (output.error) lastError = output.error;
    }
  };

  ipcWatcherManager?.watchGroup(effectiveGroup.folder);
  try {
    const executionMode = effectiveGroup.executionMode || 'container';
    const onProcessCb = (proc: ChildProcess, identifier: string) => {
      const containerName = executionMode === 'container' ? identifier : null;
      queue.registerProcess(
        virtualJid,
        proc,
        containerName,
        effectiveGroup.folder,
        identifier,
        agentId,
      );
    };

    const containerInput: ContainerInput = {
      prompt,
      sessionId,
      runtime,
      turnId: lastProcessed.id,
      groupFolder: effectiveGroup.folder,
      chatJid,
      isMain: isAdminHome,
      isHome,
      isAdminHome,
      agentId,
      agentName: agent.name,
      images: imagesForAgent,
    };

    // Write tasks/groups snapshots
    const tasks = getAllTasks();
    writeTasksSnapshot(
      effectiveGroup.folder,
      isAdminHome,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );
    const availableGroups = getAvailableGroups();
    writeGroupsSnapshot(
      effectiveGroup.folder,
      isAdminHome,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );

    const ownerHomeFolder = resolveOwnerHomeFolder(effectiveGroup);

    if (executionMode === 'host') {
      output = await runHostAgent(
        effectiveGroup,
        containerInput,
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    } else {
      output = await runContainerAgent(
        effectiveGroup,
        containerInput,
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    }

    // Finalize session
    if (output.newSessionId && output.status !== 'error') {
      setSession(effectiveGroup.folder, output.newSessionId, agentId, runtime);
    }

    // 不可恢复的转录错误（如超大图片/MIME 错配被固化在会话历史中）
    const errorForReset = [lastError, output.error].filter(Boolean).join(' ');
    if (
      (output.status === 'error' || hadError) &&
      errorForReset.includes('unrecoverable_transcript:')
    ) {
      const detail = (lastError || output.error || '').replace(
        /.*unrecoverable_transcript:\s*/,
        '',
      );
      logger.warn(
        { chatJid, agentId, folder: effectiveGroup.folder, error: detail },
        'Unrecoverable transcript error in conversation agent, auto-resetting session',
      );

      await clearSessionRuntimeFiles(effectiveGroup.folder, agentId);
      try {
        deleteSession(effectiveGroup.folder, agentId);
      } catch (err) {
        logger.error(
          { chatJid, agentId, folder: effectiveGroup.folder, err },
          'Failed to clear agent session state during auto-reset',
        );
      }

      sendSystemMessage(
        virtualChatJid,
        'context_reset',
        `会话已自动重置：${detail}`,
      );
      commitCursor();
    }

    // Only commit cursor if a reply was actually sent.  Without a reply the
    // messages haven't been "processed" — leaving the cursor behind lets the
    // recovery logic pick them up after a restart.
    if (lastAgentReplyMsgId) {
      commitCursor();
    }
  } catch (err) {
    hadError = true;
    logger.error({ agentId, chatJid, err }, 'Agent conversation error');
  } finally {
    if (idleTimer) clearTimeout(idleTimer);

    const wasInterrupted = agentStreamInterrupted && !cursorCommitted;

    // ── Streaming card cleanup ──
    if (agentStreamingSession) {
      if (agentStreamingSession.isActive()) {
        if (hadError) {
          await agentStreamingSession.abort('处理出错').catch(() => {});
        } else if (wasInterrupted) {
          await agentStreamingSession.abort('已中断').catch(() => {});
        } else {
          agentStreamingSession.dispose();
        }
      }
      if (streamingSessionJid) {
        unregisterStreamingSession(streamingSessionJid);
      }
    }

    // ── 保存中断内容 ──
    if (wasInterrupted) {
      const interruptedText = buildInterruptedReply(agentStreamingAccText);
      try {
        const msgId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        const persistedMsgId = storeMessageDirect(
          msgId,
          virtualChatJid,
          'happypaw-agent',
          ASSISTANT_NAME,
          interruptedText,
          timestamp,
          true,
          {
            meta: {
              turnId: lastProcessed.id,
              sessionId: currentAgentSessionId,
              sourceKind: 'interrupt_partial',
              finalizationReason: 'interrupted',
            },
          },
        );
        broadcastNewMessage(
          virtualChatJid,
          {
            id: persistedMsgId,
            chat_jid: virtualChatJid,
            sender: 'happypaw-agent',
            sender_name: ASSISTANT_NAME,
            content: interruptedText,
            timestamp,
            is_from_me: true,
            turn_id: lastProcessed.id,
            session_id: currentAgentSessionId,
            sdk_message_uuid: null,
            source_kind: 'interrupt_partial',
            finalization_reason: 'interrupted',
          },
          agentId,
        );
        commitCursor();
      } catch (err) {
        logger.warn(
          { err, chatJid, agentId },
          'Failed to save interrupted agent text',
        );
      }
    }

    // ── 兜底：进程异常退出导致累积文本未持久化 ──
    if (
      !cursorCommitted &&
      output?.status !== 'closed' &&
      agentStreamingAccText.trim()
    ) {
      try {
        const partialReply = buildInterruptedReply(agentStreamingAccText);
        const msgId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        const persistedMsgId = storeMessageDirect(
          msgId,
          virtualChatJid,
          'happypaw-agent',
          ASSISTANT_NAME,
          partialReply,
          timestamp,
          true,
          {
            meta: {
              turnId: lastProcessed.id,
              sessionId: currentAgentSessionId,
              sourceKind: 'interrupt_partial',
              finalizationReason: 'error',
            },
          },
        );
        broadcastNewMessage(
          virtualChatJid,
          {
            id: persistedMsgId,
            chat_jid: virtualChatJid,
            sender: 'happypaw-agent',
            sender_name: ASSISTANT_NAME,
            content: partialReply,
            timestamp,
            is_from_me: true,
            turn_id: lastProcessed.id,
            session_id: currentAgentSessionId,
            sdk_message_uuid: null,
            source_kind: 'interrupt_partial',
            finalization_reason: 'error',
          },
          agentId,
        );
        commitCursor();
      } catch (err) {
        logger.warn(
          { err, chatJid, agentId },
          'Failed to save interrupted partial agent text',
        );
      }
    }

    // ── Spawn result injection: write final output back to the source chat ──
    if (
      agent.kind === 'spawn' &&
      agent.spawned_from_jid &&
      lastAgentReplyText
    ) {
      try {
        const resultText = lastAgentReplyText;
        const injectId = crypto.randomUUID();
        const injectTs = new Date().toISOString();
        ensureChatExists(agent.spawned_from_jid);
        storeMessageDirect(
          injectId,
          agent.spawned_from_jid,
          'happypaw-agent',
          ASSISTANT_NAME,
          resultText,
          injectTs,
          true,
        );
        broadcastNewMessage(agent.spawned_from_jid, {
          id: injectId,
          chat_jid: agent.spawned_from_jid,
          sender: 'happypaw-agent',
          sender_name: ASSISTANT_NAME,
          content: resultText,
          timestamp: injectTs,
          is_from_me: true,
        });
        logger.info(
          {
            agentId,
            spawned_from_jid: agent.spawned_from_jid,
            textLen: lastAgentReplyText.length,
          },
          'Spawn result injected back to source chat',
        );
      } catch (err) {
        logger.error(
          { agentId, err },
          'Failed to inject spawn result back to source chat',
        );
      }
    }

    // Process ended → set status back to idle (conversation agents persist).
    // Spawn agents are fire-and-forget: mark as completed (or error) so they
    // don't accumulate in the active agent list.
    // MUST be inside finally so status is reset even on unhandled exceptions (#227).
    const endStatus =
      agent.kind === 'spawn' ? (hadError ? 'error' : 'completed') : 'idle';
    updateAgentStatus(agentId, endStatus, hadError ? lastError : undefined);
    broadcastAgentStatus(
      chatJid,
      agentId,
      endStatus,
      agent.name,
      agent.prompt,
      hadError ? lastError : undefined,
    );

    ipcWatcherManager?.unwatchGroup(effectiveGroup.folder);
  }
}

async function ensureDockerRunning(): Promise<void> {
  // Skip all Docker checks when no groups use container mode
  if (!hasContainerModeGroups()) {
    logger.info('All groups use host execution mode, skipping Docker checks');
    return;
  }

  if (!(await isDockerAvailable())) {
    logger.warn(
      'Docker is not available — container-mode workspaces will fail at message time. ' +
        'Start Docker if you need container execution (macOS: Docker Desktop, Linux: sudo systemctl start docker).',
    );
    return;
  }
  logger.debug('Docker daemon is running');

  // Kill orphaned host agent-runner processes from previous runs
  try {
    const { stdout: psOut } = await execFileAsync(
      'pgrep',
      ['-f', 'node.*container/agent-runner/dist/index\\.js'],
      { timeout: 5000 },
    );
    const pids = (typeof psOut === 'string' ? psOut : String(psOut))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid && !isNaN(pid));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    if (pids.length > 0) {
      logger.info(
        { count: pids.length, pids },
        'Killed orphaned host agent-runner processes',
      );
    }
  } catch (err: any) {
    // pgrep exits 1 when no matches — that's fine
    if (err?.code !== 1) {
      logger.warn({ err }, 'Failed to clean up orphaned host processes');
    }
  }

  // Kill and clean up orphaned happypaw containers from previous runs
  try {
    const orphanSet = new Set<string>();
    for (const prefix of ['happypaw-', toLegacyProductToken('happypaw-')]) {
      const { stdout } = await execFileAsync(
        'docker',
        ['ps', '--filter', `name=${prefix}`, '--format', '{{.Names}}'],
        { timeout: 10000 },
      );
      const output = typeof stdout === 'string' ? stdout : String(stdout);
      for (const name of output.trim().split('\n').filter(Boolean)) {
        orphanSet.add(name);
      }
    }
    const orphans = [...orphanSet];
    for (const name of orphans) {
      try {
        await execFileAsync('docker', ['stop', name], { timeout: 10000 });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

function movePathWithFallback(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err: unknown) {
    // Cross-device rename fallback.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * One-shot migration: move legacy top-level directories into data/.
 * - store/messages.db* → data/db/messages.db*
 * - groups/            → data/groups/
 * Also supports partial migrations (old+new paths both exist).
 */
function migrateDataDirectories(): void {
  const projectRoot = process.cwd();

  // 1. Migrate store/ → data/db/
  const oldStoreDir = path.join(projectRoot, 'store');
  if (fs.existsSync(oldStoreDir)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Move messages.db and WAL files
    for (const file of ['messages.db', 'messages.db-wal', 'messages.db-shm']) {
      const src = path.join(oldStoreDir, file);
      const dst = path.join(STORE_DIR, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        movePathWithFallback(src, dst);
        logger.info({ src, dst }, 'Migrated database file');
      }
    }
    // Remove old store/ if empty
    try {
      fs.rmdirSync(oldStoreDir);
    } catch {
      // Not empty — leave it
    }
  }

  // 2. Migrate groups/ → data/groups/
  const oldGroupsDir = path.join(projectRoot, 'groups');
  if (fs.existsSync(oldGroupsDir)) {
    fs.mkdirSync(path.dirname(GROUPS_DIR), { recursive: true });
    if (!fs.existsSync(GROUPS_DIR)) {
      movePathWithFallback(oldGroupsDir, GROUPS_DIR);
      logger.info(
        { src: oldGroupsDir, dst: GROUPS_DIR },
        'Migrated groups directory',
      );
    } else {
      // Partial migration: move missing entries one-by-one.
      const entries = fs.readdirSync(oldGroupsDir, { withFileTypes: true });
      for (const entry of entries) {
        const src = path.join(oldGroupsDir, entry.name);
        const dst = path.join(GROUPS_DIR, entry.name);
        if (!fs.existsSync(dst)) {
          movePathWithFallback(src, dst);
          logger.info({ src, dst }, 'Migrated legacy group entry');
        }
      }
      try {
        fs.rmdirSync(oldGroupsDir);
      } catch {
        // Not empty — leave it
      }
    }
  }
}

/**
 * One-shot migration: copy shared global CLAUDE.md → first admin's user-global dir.
 * Creates user-global directories for all existing users.
 * Idempotent via flag file.
 */
function migrateGlobalMemoryToPerUser(): void {
  const flagFile = path.join(DATA_DIR, 'config', '.memory-migration-v1-done');
  if (fs.existsSync(flagFile)) return;

  const oldGlobalMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  const userGlobalBase = path.join(GROUPS_DIR, 'user-global');

  let migrationSucceeded = true;
  let copiedLegacyGlobal = !fs.existsSync(oldGlobalMd);

  // Find first admin user
  try {
    const result = listUsers({
      role: 'admin',
      status: 'active',
      page: 1,
      pageSize: 1,
    });
    const firstAdmin = result.users[0];

    if (firstAdmin && fs.existsSync(oldGlobalMd)) {
      const adminDir = path.join(userGlobalBase, firstAdmin.id);
      fs.mkdirSync(adminDir, { recursive: true });
      const target = path.join(adminDir, 'CLAUDE.md');
      if (!fs.existsSync(target)) {
        fs.copyFileSync(oldGlobalMd, target);
        logger.info(
          { userId: firstAdmin.id, src: oldGlobalMd, dst: target },
          'Migrated global CLAUDE.md to admin user-global',
        );
      }
      copiedLegacyGlobal = true;
    } else if (!firstAdmin && fs.existsSync(oldGlobalMd)) {
      migrationSucceeded = false;
      logger.warn(
        'No active admin found for legacy global memory migration; will retry on next startup',
      );
    }

    // Create user-global dirs for all users
    let page = 1;
    const allUsers: Array<{ id: string }> = [];
    while (true) {
      const r = listUsers({ status: 'active', page, pageSize: 200 });
      allUsers.push(...r.users);
      if (allUsers.length >= r.total) break;
      page++;
    }
    for (const u of allUsers) {
      fs.mkdirSync(path.join(userGlobalBase, u.id), { recursive: true });
    }
  } catch (err) {
    migrationSucceeded = false;
    logger.warn({ err }, 'Global memory migration encountered an error');
  }

  if (!migrationSucceeded) {
    logger.warn(
      'Global memory migration incomplete; will retry on next startup',
    );
    return;
  }

  if (!copiedLegacyGlobal) {
    logger.warn(
      'Legacy global memory has not been copied; will retry on next startup',
    );
    return;
  }

  try {
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, new Date().toISOString());
    logger.info('Global memory migration to per-user completed');
  } catch (err) {
    logger.warn({ err }, 'Failed to persist global memory migration flag');
  }
}

async function main(): Promise<void> {
  migrateDataDirectories();
  initDatabase();
  logger.info('Database initialized');

  // Clean up stale completed agents (task + spawn, older than 1 hour) to prevent DB bloat
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cleaned = deleteCompletedAgents(oneHourAgo);
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale completed agents');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale task agents');
  }

  // After process restart there cannot be truly running SDK tasks.
  // Mark all persisted running tasks as error to avoid stale "running" tabs.
  try {
    const marked = markAllRunningTaskAgentsAsError();
    if (marked > 0) {
      logger.warn(
        { marked },
        'Marked stale running task agents as error at startup',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to mark stale running tasks at startup');
  }

  // Spawn agents (from /sw) lose their in-memory task callbacks on restart.
  // Mark idle/running spawn agents as error so they don't render as "正在思考...".
  try {
    const marked = markStaleSpawnAgentsAsError();
    if (marked > 0) {
      logger.warn({ marked }, 'Marked stale spawn agents as error at startup');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to mark stale spawn agents at startup');
  }

  // WeChat iLink API domains bypass proxy (applied at startup, updated on config save)
  updateWeChatNoProxy(true);

  // Migrate system-level IM config → admin's per-user config (one-time)
  migrateSystemIMToPerUser();

  loadState();

  // --- Channel reload helpers (hot-reload on config save) ---

  let feishuSyncInterval: ReturnType<typeof setInterval> | null = null;

  // Graceful shutdown handlers
  let shutdownInProgress = false;
  const shutdown = async (signal: string) => {
    if (shutdownInProgress) {
      logger.warn('Force exit (second signal)');
      process.exit(1);
    }
    shutdownInProgress = true;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received, cleaning up...');

    // Force exit after 2s if graceful shutdown hangs
    const forceExitTimer = setTimeout(() => {
      logger.warn('Graceful shutdown timed out, force exiting');
      process.exit(1);
    }, 2000);
    forceExitTimer.unref();

    if (feishuSyncInterval) {
      clearInterval(feishuSyncInterval);
      feishuSyncInterval = null;
    }

    try {
      ipcWatcherManager?.closeAll();
    } catch (err) {
      logger.warn({ err }, 'Error closing IPC watchers');
    }

    try {
      shutdownTerminals();
    } catch (err) {
      logger.warn({ err }, 'Error shutting down terminals');
    }

    // Stop periodic buffer, then persist streaming text to DB + clean buffer files.
    stopStreamingBuffer();
    saveInterruptedStreamingMessages();

    // Run cleanup tasks concurrently with a tight timeout
    await Promise.allSettled([
      // Abort all active streaming cards before disconnecting IM,
      // so users see "服务维护中" instead of a stuck "生成中..." card.
      abortAllStreamingSessions('服务维护中').catch((err) =>
        logger.warn({ err }, 'Error aborting streaming sessions'),
      ),
      imManager
        .disconnectAll()
        .catch((err) =>
          logger.warn({ err }, 'Error disconnecting IM connections'),
        ),
      shutdownWebServer().catch((err) =>
        logger.warn({ err }, 'Error shutting down web server'),
      ),
      queue
        .shutdown(1500)
        .catch((err) => logger.warn({ err }, 'Error shutting down queue')),
    ]);

    try {
      closeDatabase();
    } catch (err) {
      logger.warn({ err }, 'Error closing database');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Reload Feishu connection for a specific user (hot-reload on config save)
  const reloadFeishuConnection = async (config: {
    appId: string;
    appSecret: string;
    enabled?: boolean;
  }): Promise<boolean> => {
    // Find admin user's home folder (legacy global config routes to admin)
    const adminUsers = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    }).users;
    const adminUser = adminUsers[0];
    if (!adminUser) {
      logger.warn('No admin user found for Feishu reload');
      return false;
    }

    // Disconnect existing admin Feishu connection
    await imManager.disconnectUserFeishu(adminUser.id);
    if (feishuSyncInterval) {
      clearInterval(feishuSyncInterval);
      feishuSyncInterval = null;
    }

    if (config.enabled !== false && config.appId && config.appSecret) {
      const homeGroup = getUserHomeGroup(adminUser.id);
      const homeFolder = homeGroup?.folder || MAIN_GROUP_FOLDER;
      const onNewChat = buildOnNewChat(adminUser.id, homeFolder);
      const connected = await imManager.connectUserFeishu(
        adminUser.id,
        config,
        onNewChat,
        {
          ignoreMessagesBefore: Date.now(),
          onCommand: handleCommand,
          onBotAddedToGroup: buildOnNewChat(adminUser.id, homeFolder),
          onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
          shouldProcessGroupMessage,
          onCardInterrupt: handleCardInterrupt,
        },
      );
      if (connected) {
        syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Group sync after Feishu reconnect failed'),
        );
        feishuSyncInterval = setInterval(() => {
          syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Periodic group sync failed'),
          );
        }, GROUP_SYNC_INTERVAL_MS);
      }
      return connected;
    }
    logger.info('Feishu channel disabled via hot-reload');
    return false;
  };

  const reloadTelegramConnection = async (config: {
    botToken: string;
    proxyUrl?: string;
    enabled?: boolean;
  }): Promise<boolean> => {
    // Find admin user
    const adminUsers = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    }).users;
    const adminUser = adminUsers[0];
    if (!adminUser) {
      logger.warn('No admin user found for Telegram reload');
      return false;
    }

    await imManager.disconnectUserTelegram(adminUser.id);

    if (config.enabled !== false && config.botToken) {
      const homeGroup = getUserHomeGroup(adminUser.id);
      const homeFolder = homeGroup?.folder || MAIN_GROUP_FOLDER;
      const onNewChat = buildOnNewChat(adminUser.id, homeFolder);
      const connected = await imManager.connectUserTelegram(
        adminUser.id,
        config,
        onNewChat,
        buildIsChatAuthorized(adminUser.id),
        buildOnPairAttempt(adminUser.id),
        {
          onCommand: handleCommand,
          ignoreMessagesBefore: Date.now(),
          resolveGroupFolder: (chatJid) => resolveEffectiveFolder(chatJid),
          resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
          onAgentMessage: buildOnAgentMessage(),
          onBotAddedToGroup: buildTelegramBotAddedHandler(
            adminUser.id,
            homeFolder,
          ),
          onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
        },
      );
      return connected;
    }
    logger.info('Telegram channel disabled via hot-reload');
    return false;
  };

  // Reload a per-user IM channel (hot-reload on user-im config save)
  const reloadUserIMConfig = async (
    userId: string,
    channel: 'feishu' | 'telegram' | 'qq' | 'wechat',
  ): Promise<boolean> => {
    const homeGroup = getUserHomeGroup(userId);
    if (!homeGroup) {
      logger.warn(
        { userId, channel },
        'No home group found for user IM reload',
      );
      return false;
    }
    const homeFolder = homeGroup.folder;
    const onNewChat = buildOnNewChat(userId, homeFolder);
    const ignoreMessagesBefore = Date.now();

    if (channel === 'feishu') {
      await imManager.disconnectUserFeishu(userId);
      const config = getUserFeishuConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.appId &&
        config.appSecret
      ) {
        const connected = await imManager.connectUserFeishu(
          userId,
          config,
          onNewChat,
          {
            ignoreMessagesBefore,
            onCommand: handleCommand,
            onBotAddedToGroup: buildOnNewChat(userId, homeFolder),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            shouldProcessGroupMessage,
            onCardInterrupt: handleCardInterrupt,
          },
        );
        logger.info(
          { userId, connected },
          'User Feishu connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User Feishu channel disabled via hot-reload');
      return false;
    } else if (channel === 'telegram') {
      await imManager.disconnectUserTelegram(userId);
      const config = getUserTelegramConfig(userId);
      const globalTelegramConfig = getTelegramProviderConfig();
      if (config && config.enabled !== false && config.botToken) {
        const connected = await imManager.connectUserTelegram(
          userId,
          {
            ...config,
            proxyUrl: config.proxyUrl || globalTelegramConfig.proxyUrl,
          },
          onNewChat,
          buildIsChatAuthorized(userId),
          buildOnPairAttempt(userId),
          {
            onCommand: handleCommand,
            ignoreMessagesBefore,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onBotAddedToGroup: buildTelegramBotAddedHandler(userId, homeFolder),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
          },
        );
        logger.info(
          { userId, connected },
          'User Telegram connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User Telegram channel disabled via hot-reload');
      return false;
    } else if (channel === 'qq') {
      await imManager.disconnectUserQQ(userId);
      const config = getUserQQConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.appId &&
        config.appSecret
      ) {
        const connected = await imManager.connectUserQQ(
          userId,
          config,
          onNewChat,
          buildIsChatAuthorized(userId),
          buildOnPairAttempt(userId),
          {
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
          },
        );
        logger.info({ userId, connected }, 'User QQ connection hot-reloaded');
        return connected;
      }
      logger.info({ userId }, 'User QQ channel disabled via hot-reload');
      return false;
    } else {
      // WeChat
      await imManager.disconnectUserWeChat(userId);
      const config = getUserWeChatConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.botToken &&
        config.ilinkBotId
      ) {
        const connected = await imManager.connectUserWeChat(
          userId,
          {
            botToken: config.botToken,
            ilinkBotId: config.ilinkBotId,
            baseUrl: config.baseUrl,
            cdnBaseUrl: config.cdnBaseUrl,
            getUpdatesBuf: config.getUpdatesBuf,
          },
          onNewChat,
          {
            ignoreMessagesBefore: Date.now(),
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
          },
        );
        logger.info(
          { userId, connected },
          'User WeChat connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User WeChat channel disabled via hot-reload');
      return false;
    }
  };

  // Start Web server early so frontend auth/API isn't blocked by Feishu readiness.
  startWebServer({
    queue,
    getRegisteredGroups: () => registeredGroups,
    getSessions: () => sessions,
    processGroupMessages,
    ensureTerminalContainerStarted,
    formatMessages,
    getLastAgentTimestamp: () => lastAgentTimestamp,
    setLastAgentTimestamp: setCursors,
    advanceGlobalCursor: (cursor: MessageCursor) => {
      if (isCursorAfter(cursor, globalMessageCursor)) {
        globalMessageCursor = cursor;
        saveState();
      }
    },
    reloadFeishuConnection,
    reloadTelegramConnection,
    reloadUserIMConfig,
    isFeishuConnected: () => imManager.isAnyFeishuConnected(),
    isTelegramConnected: () => imManager.isAnyTelegramConnected(),
    isUserFeishuConnected: (userId: string) =>
      imManager.isFeishuConnected(userId),
    isUserTelegramConnected: (userId: string) =>
      imManager.isTelegramConnected(userId),
    isUserQQConnected: (userId: string) => imManager.isQQConnected(userId),
    isUserWeChatConnected: (userId: string) =>
      imManager.isWeChatConnected(userId),
    processAgentConversation,
    getFeishuChatInfo: (userId: string, chatId: string) =>
      imManager.getFeishuChatInfo(userId, chatId),
    clearImFailCounts: (jid: string) => {
      imHealthCheckFailCounts.delete(jid);
    },
    updateReplyRoute: (folder: string, sourceJid: string | null) => {
      activeRouteUpdaters.get(folder)?.(sourceJid);
    },
    handleSpawnCommand,
  });

  // Clean expired sessions every hour
  setInterval(
    () => {
      try {
        const expiredIds = getExpiredSessionIds();
        for (const id of expiredIds) invalidateSessionCache(id);
        const deleted = deleteExpiredSessions();
        if (deleted > 0) {
          logger.info({ deleted }, 'Cleaned expired user sessions');
        }
      } catch (err) {
        logger.error({ err }, 'Failed to clean expired sessions');
      }
    },
    60 * 60 * 1000,
  );

  // Periodically clean completed agents (task + spawn, every 10 minutes)
  setInterval(
    () => {
      try {
        const tenMinutesAgo = new Date(
          Date.now() - 10 * 60 * 1000,
        ).toISOString();
        const cleaned = deleteCompletedAgents(tenMinutesAgo);
        if (cleaned > 0) {
          logger.info(
            { cleaned },
            'Periodic cleanup: removed completed agents',
          );
        }
      } catch (err) {
        logger.warn({ err }, 'Failed periodic task agent cleanup');
      }
    },
    10 * 60 * 1000,
  );

  // Billing: check expired subscriptions every hour
  setInterval(
    () => {
      checkAndExpireSubscriptions();
    },
    60 * 60 * 1000,
  );

  // Billing: reconcile monthly usage every 6 hours
  setInterval(
    () => {
      if (!isBillingEnabled()) return;
      try {
        const month = new Date().toISOString().slice(0, 7);
        // Reconcile all non-admin users with pagination
        let page = 1;
        const pageSize = 200;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = listUsers({ status: 'active', pageSize, page });
          for (const u of batch.users) {
            if (u.role === 'admin') continue;
            reconcileMonthlyUsage(u.id, month);
          }
          if (batch.users.length < pageSize) break;
          page++;
        }
      } catch (err) {
        logger.error({ err }, 'Failed to run monthly usage reconciliation');
      }
    },
    6 * 60 * 60 * 1000,
  );

  // Billing: cleanup old daily_usage and billing_audit_log every 24 hours
  setInterval(
    () => {
      try {
        const deletedDaily = cleanupOldDailyUsage();
        const deletedAudit = cleanupOldBillingAuditLog();
        if (deletedDaily > 0 || deletedAudit > 0) {
          logger.info(
            { deletedDaily, deletedAudit },
            'Cleaned up old billing data',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to cleanup old billing data');
      }
    },
    24 * 60 * 60 * 1000,
  );

  // Skills auto-sync: periodically sync host skills to all admin users
  let skillAutoSyncTimer: ReturnType<typeof setInterval> | null = null;

  function startSkillAutoSync(): void {
    stopSkillAutoSync();
    const settings = getSystemSettings();
    if (!settings.skillAutoSyncEnabled) return;

    const intervalMs = settings.skillAutoSyncIntervalMinutes * 60 * 1000;
    logger.info(
      { intervalMinutes: settings.skillAutoSyncIntervalMinutes },
      'Starting skill auto-sync timer',
    );

    const runSync = async () => {
      const currentSettings = getSystemSettings();
      if (!currentSettings.skillAutoSyncEnabled) {
        stopSkillAutoSync();
        return;
      }

      try {
        const { users: adminUsers } = listUsers({
          role: 'admin',
          status: 'active',
        });
        for (const admin of adminUsers) {
          try {
            const result = await syncHostSkillsForUser(admin.id);
            const { added, updated, deleted } = result.stats;
            if (added > 0 || updated > 0 || deleted > 0) {
              logger.info(
                {
                  userId: admin.id,
                  username: admin.username,
                  ...result.stats,
                  total: result.total,
                },
                'Skill auto-sync completed with changes',
              );
            }
          } catch (err) {
            logger.warn(
              { err, userId: admin.id },
              'Skill auto-sync failed for user',
            );
          }
        }
      } catch (err) {
        logger.error({ err }, 'Skill auto-sync failed');
      }
    };

    // Run once immediately, then on interval
    void runSync();
    skillAutoSyncTimer = setInterval(() => void runSync(), intervalMs);
  }

  function stopSkillAutoSync(): void {
    if (skillAutoSyncTimer) {
      clearInterval(skillAutoSyncTimer);
      skillAutoSyncTimer = null;
    }
  }

  // Initial start + restart when settings change (check every 60s)
  const initSettings = getSystemSettings();
  let _lastSkillSyncEnabled: boolean = initSettings.skillAutoSyncEnabled;
  let _lastSkillSyncInterval: number =
    initSettings.skillAutoSyncIntervalMinutes;
  startSkillAutoSync();

  setInterval(() => {
    const settings = getSystemSettings();
    if (
      settings.skillAutoSyncEnabled !== _lastSkillSyncEnabled ||
      settings.skillAutoSyncIntervalMinutes !== _lastSkillSyncInterval
    ) {
      _lastSkillSyncEnabled = settings.skillAutoSyncEnabled;
      _lastSkillSyncInterval = settings.skillAutoSyncIntervalMinutes;
      startSkillAutoSync();
    }
  }, 60 * 1000);

  await ensureDockerRunning();

  queue.setProcessMessagesFn(processGroupMessages);
  queue.setHostModeChecker((groupJid: string) => {
    const baseJid = stripVirtualJidSuffix(groupJid);

    let group = registeredGroups[baseJid];
    if (!group) {
      const dbGroup = getRegisteredGroup(baseJid);
      if (dbGroup) {
        registeredGroups[baseJid] = dbGroup;
        group = dbGroup;
      }
    }
    if (!group) return false;

    const { effectiveGroup } = resolveEffectiveGroup(group);
    return effectiveGroup.executionMode === 'host';
  });
  queue.setSerializationKeyResolver((groupJid: string) => {
    // Agent virtual JIDs: {chatJid}#agent:{agentId} → separate serialization key
    const agentSep = groupJid.indexOf('#agent:');
    if (agentSep >= 0) {
      const baseJid = groupJid.slice(0, agentSep);
      const agentId = groupJid.slice(agentSep + 7);
      const group = registeredGroups[baseJid];
      const folder = group?.folder || baseJid;
      return `${folder}#${agentId}`;
    }
    // Task virtual JIDs: {chatJid}#task:{taskId} → separate serialization key
    const taskSep = groupJid.indexOf('#task:');
    if (taskSep >= 0) {
      const baseJid = groupJid.slice(0, taskSep);
      const taskId = groupJid.slice(taskSep + 6);
      const group = registeredGroups[baseJid];
      return `${group?.folder || baseJid}#task:${taskId}`;
    }
    const group = registeredGroups[groupJid];
    return group?.folder || groupJid;
  });
  queue.setOnMaxRetriesExceeded((groupJid: string) => {
    const group = registeredGroups[groupJid];
    const name = group?.name || groupJid;
    sendSystemMessage(
      groupJid,
      'agent_max_retries',
      `${name} 处理失败，已达最大重试次数`,
    );
    setTyping(groupJid, false);
  });
  // Billing: user-level concurrent container limit
  queue.setUserConcurrentLimitChecker((groupJid: string) => {
    if (!isBillingEnabled()) return { allowed: true };
    const baseJid = stripVirtualJidSuffix(groupJid);
    const group = registeredGroups[baseJid];
    if (!group?.created_by) return { allowed: true };
    const owner = getUserById(group.created_by);
    if (!owner || owner.role === 'admin') return { allowed: true };
    const limit = getUserConcurrentContainerLimit(owner.id, owner.role);
    if (limit == null) return { allowed: true };
    // Count active containers for this user
    let userActive = 0;
    for (const [jid, g] of Object.entries(registeredGroups)) {
      if (g.created_by === owner.id && queue.hasDirectActiveRunner(jid)) {
        userActive++;
      }
    }
    return { allowed: userActive < limit };
  });
  // Recovery: when agent process exits with unconsumed IPC messages,
  // re-enqueue processAgentConversation to pick them up. See issue #240.
  queue.setOnUnconsumedAgentIpc((groupJid: string, agentId: string) => {
    // Extract base chat JID from virtual JID (e.g. web:main#agent:abc → web:main)
    const baseChatJid = groupJid.includes('#agent:')
      ? groupJid.split('#agent:')[0]
      : groupJid;
    const agent = getAgent(agentId);
    const homeChatJid = agent?.chat_jid || baseChatJid;
    const virtualChatJid = `${homeChatJid}#agent:${agentId}`;
    const taskId = `agent-ipc-recovery:${agentId}:${Date.now()}`;
    queue.enqueueTask(virtualChatJid, taskId, async () => {
      await processAgentConversation(homeChatJid, agentId);
    });
  });
  const schedulerDeps: import('./task-scheduler.js').SchedulerDependencies = {
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (
      groupJid,
      proc,
      containerName,
      groupFolder,
      displayName,
      taskRunId,
    ) =>
      queue.registerProcess(
        groupJid,
        proc,
        containerName,
        groupFolder,
        displayName,
        undefined, // agentId
        taskRunId,
      ),
    sendMessage,
    assistantName: ASSISTANT_NAME,
    dailySummaryDeps: {
      logger,
      dataDir: DATA_DIR,
    },
  };
  startSchedulerLoop(schedulerDeps);

  // Inject triggerTaskRun into WebDeps (schedulerDeps must exist first)
  const webDeps = getWebDeps();
  if (webDeps) {
    webDeps.triggerTaskRun = (taskId: string) =>
      triggerTaskNow(taskId, schedulerDeps);
  }

  startIpcWatcher();
  recoverStreamingBuffer();
  recoverPendingMessages();
  recoverConversationAgents();
  startStreamingBuffer();
  startMessageLoop();

  // --- IM Connection Pool: connect per-user IM channels ---
  // Load global IM config (backward compat: used for admin if no per-user config exists)
  const globalFeishuConfig = getFeishuProviderConfigWithSource();
  const globalTelegramConfig = getTelegramProviderConfigWithSource();

  // Paginate through all active users (listUsers caps at 200 per page)
  let allActiveUsers: typeof listUsers extends (...args: any) => {
    users: infer U;
  }
    ? U
    : never = [];
  {
    let page = 1;
    while (true) {
      const result = listUsers({ status: 'active', page, pageSize: 200 });
      allActiveUsers = allActiveUsers.concat(result.users);
      if (allActiveUsers.length >= result.total) break;
      page++;
    }
  }

  // Register admin users for fallback IM routing
  for (const user of allActiveUsers) {
    if (user.role === 'admin') imManager.registerAdminUser(user.id);
  }

  let anyFeishuConnected = false;

  for (const user of allActiveUsers) {
    const homeGroup = getUserHomeGroup(user.id);
    if (!homeGroup) continue;

    // Per-user IM config takes precedence; fall back to global config for admin
    const userFeishu = getUserFeishuConfig(user.id);
    const userTelegram = getUserTelegramConfig(user.id);
    const userQQ = getUserQQConfig(user.id);
    const userWeChat = getUserWeChatConfig(user.id);

    // Determine effective Feishu config: per-user > global (admin only)
    let effectiveFeishu: FeishuConnectConfig | null = null;
    if (userFeishu && userFeishu.appId && userFeishu.appSecret) {
      effectiveFeishu = {
        appId: userFeishu.appId,
        appSecret: userFeishu.appSecret,
        enabled: userFeishu.enabled,
      };
    } else if (user.role === 'admin' && globalFeishuConfig.source !== 'none') {
      const gc = globalFeishuConfig.config;
      effectiveFeishu = {
        appId: gc.appId,
        appSecret: gc.appSecret,
        enabled: gc.enabled,
      };
    }

    // Determine effective Telegram config: per-user > global (admin only)
    let effectiveTelegram: TelegramConnectConfig | null = null;
    if (userTelegram && userTelegram.botToken) {
      effectiveTelegram = {
        botToken: userTelegram.botToken,
        proxyUrl: userTelegram.proxyUrl || globalTelegramConfig.config.proxyUrl,
        enabled: userTelegram.enabled,
      };
    } else if (
      user.role === 'admin' &&
      globalTelegramConfig.source !== 'none'
    ) {
      const gc = globalTelegramConfig.config;
      effectiveTelegram = {
        botToken: gc.botToken,
        proxyUrl: gc.proxyUrl,
        enabled: gc.enabled,
      };
    }

    // Determine effective QQ config: per-user only (no global fallback)
    let effectiveQQ: QQConnectConfig | null = null;
    if (userQQ && userQQ.appId && userQQ.appSecret) {
      effectiveQQ = {
        appId: userQQ.appId,
        appSecret: userQQ.appSecret,
        enabled: userQQ.enabled,
      };
    }

    // Determine effective WeChat config: per-user only (no global fallback)
    let effectiveWeChat: WeChatConnectConfig | null = null;
    if (userWeChat && userWeChat.botToken && userWeChat.ilinkBotId) {
      effectiveWeChat = {
        botToken: userWeChat.botToken,
        ilinkBotId: userWeChat.ilinkBotId,
        baseUrl: userWeChat.baseUrl,
        cdnBaseUrl: userWeChat.cdnBaseUrl,
        getUpdatesBuf: userWeChat.getUpdatesBuf,
        enabled: userWeChat.enabled,
      };
    }

    if (
      !effectiveFeishu &&
      !effectiveTelegram &&
      !effectiveQQ &&
      !effectiveWeChat
    )
      continue;

    try {
      const result = await connectUserIMChannels(
        user.id,
        homeGroup.folder,
        effectiveFeishu,
        effectiveTelegram,
        effectiveQQ,
        effectiveWeChat,
        Date.now(),
      );
      if (result.feishu) anyFeishuConnected = true;
      logger.info(
        {
          userId: user.id,
          feishu: result.feishu,
          telegram: result.telegram,
          qq: result.qq,
          wechat: result.wechat,
        },
        'User IM channels connected',
      );
    } catch (err) {
      logger.error(
        { userId: user.id, err },
        'Failed to connect user IM channels',
      );
    }
  }

  // Start Feishu group sync if any connection is active
  if (anyFeishuConnected) {
    syncGroupMetadata().catch((err) =>
      logger.error({ err }, 'Initial group sync failed'),
    );
    feishuSyncInterval = setInterval(() => {
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Periodic group sync failed'),
      );
    }, GROUP_SYNC_INTERVAL_MS);
  } else if (
    globalFeishuConfig.config.enabled !== false &&
    globalFeishuConfig.source !== 'none'
  ) {
    logger.warn(
      'Feishu is not connected. Configure credentials in Settings to enable Feishu sync.',
    );
  }

  // Run health check once on startup to clean up orphaned bindings, then periodically
  void checkImBindingsHealth();
  const IM_BINDING_HEALTH_CHECK_INTERVAL = 30 * 60 * 1000; // 30 min
  setInterval(() => {
    void checkImBindingsHealth();
  }, IM_BINDING_HEALTH_CHECK_INTERVAL);
}

async function checkImBindingsHealth(): Promise<void> {
  const boundEntries: Array<{ jid: string; group: RegisteredGroup }> = [];
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.target_agent_id || group.target_main_jid) {
      boundEntries.push({ jid, group });
    }
  }

  if (boundEntries.length === 0) return;
  logger.debug(
    { count: boundEntries.length },
    'Running IM binding health check',
  );

  for (const { jid, group } of boundEntries) {
    // Check for orphaned target_main_jid — target workspace no longer exists
    if (group.target_main_jid) {
      const targetGroup =
        registeredGroups[group.target_main_jid] ??
        getRegisteredGroup(group.target_main_jid);
      if (!targetGroup) {
        unbindImGroup(
          jid,
          `Orphaned main conversation binding: target ${group.target_main_jid} no longer exists`,
        );
        continue;
      }
    }

    // Check for orphaned target_agent_id — agent no longer exists
    if (group.target_agent_id) {
      const agent = getAgent(group.target_agent_id);
      if (!agent) {
        unbindImGroup(
          jid,
          `Orphaned agent binding: agent ${group.target_agent_id} no longer exists`,
        );
        continue;
      }
    }

    try {
      const info = await imManager.getChatInfo(jid);
      if (info === undefined) {
        // Channel doesn't support getChatInfo (e.g. Telegram, QQ) — skip reachability check
        continue;
      }
      if (info === null) {
        // Chat not reachable — could be temporary (connection down, API permission issue)
        const count = (imHealthCheckFailCounts.get(jid) ?? 0) + 1;
        imHealthCheckFailCounts.set(jid, count);
        if (count >= IM_HEALTH_CHECK_FAIL_THRESHOLD) {
          unbindImGroup(
            jid,
            'IM group not reachable after multiple checks, auto-unbinding',
          );
        } else {
          logger.debug(
            {
              jid,
              failCount: count,
              threshold: IM_HEALTH_CHECK_FAIL_THRESHOLD,
            },
            'IM health check failed, will retry before unbinding',
          );
        }
      } else {
        // Chat is reachable — reset failure counter
        imHealthCheckFailCounts.delete(jid);
      }
    } catch (err) {
      // API error — could be temporary, don't unbind on single failure
      logger.debug({ jid, err }, 'IM binding health check failed for group');
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start happypaw');
  process.exit(1);
});

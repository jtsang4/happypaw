import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import type { AvailableGroup } from './container-runner.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';
import { logger } from './logger.js';

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;

interface SendMessageOptions {
  sendToIM?: boolean;
  localImagePaths?: string[];
  source?: string;
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

interface IpcTaskPayload {
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
  jid?: string;
  name?: string;
  folder?: string;
  containerConfig?: RegisteredGroup['containerConfig'];
  executionMode?: string;
  package?: string;
  requestId?: string;
  skillId?: string;
  filePath?: string;
  fileName?: string;
  isAdminHome?: boolean;
}

interface IpcRuntimeDeps {
  dataDir: string;
  groupsDir: string;
  mainGroupFolder: string;
  timezone: string;
  assistantName: string;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getShuttingDown: () => boolean;
  getActiveImReplyRoute: (folder: string) => string | null | undefined;
  sendMessage: (
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ) => Promise<string | undefined>;
  ensureChatExists: (jid: string) => void;
  storeMessageDirect: (...args: any[]) => string;
  broadcastNewMessage: (
    jid: string,
    message: any,
    agentId?: string,
    source?: string,
  ) => void;
  broadcastToWebClients: (jid: string, text: string) => void;
  extractLocalImImagePaths: (text: string, groupFolder?: string) => string[];
  sendImWithFailTracking: (
    imJid: string,
    text: string,
    localImagePaths: string[],
  ) => void;
  retryImOperation: (
    opName: string,
    jid: string,
    fn: () => Promise<void>,
  ) => Promise<boolean>;
  getChannelType: (jid: string) => string | null;
  getGroupsByOwner: (userId: string) => Array<{ jid: string; folder: string }>;
  getConnectedChannelTypes: (userId: string) => string[];
  sendImage: (
    jid: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ) => Promise<void>;
  sendFile: (jid: string, filePath: string, fileName: string) => Promise<void>;
  createTask: (task: {
    id: string;
    group_folder: string;
    chat_jid: string;
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode: 'group' | 'isolated';
    execution_type: 'agent' | 'script';
    script_command: string | null;
    next_run: string | null;
    status: 'active' | 'paused' | 'completed';
    created_at: string;
  }) => void;
  deleteTask: (id: string) => void;
  getAllTasks: () => ScheduledTask[];
  getTaskById: (id: string) => ScheduledTask | undefined;
  updateTask: (
    id: string,
    patch: Partial<Pick<ScheduledTask, 'status'>>,
  ) => void;
  syncGroupMetadata: (force?: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    folder: string,
    isAdminHome: boolean,
    groups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  installSkillForUser: (
    userId: string,
    pkg: string,
  ) => Promise<Record<string, unknown>>;
  deleteSkillForUser: (
    userId: string,
    skillId: string,
  ) => Record<string, unknown>;
}

class IpcWatcherManager {
  private watchers = new Map<
    string,
    { watchers: fs.FSWatcher[]; refCount: number }
  >();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processingFolders = new Set<string>();
  private pendingReprocess = new Set<string>();
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      dataDir: string;
      getShuttingDown: () => boolean;
      processGroup: (folder: string) => Promise<void>;
      processFull: () => Promise<void>;
    },
  ) {}

  watchGroup(folder: string): void {
    const existing = this.watchers.get(folder);
    if (existing) {
      existing.refCount++;
      return;
    }

    const groupIpcRoot = path.join(this.deps.dataDir, 'ipc', folder);
    const dirsToWatch = [
      path.join(groupIpcRoot, 'messages'),
      path.join(groupIpcRoot, 'tasks'),
    ];

    const folderWatchers: fs.FSWatcher[] = [];
    for (const dir of dirsToWatch) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const watcher = fs.watch(dir, () => {
          this.debouncedProcess(folder);
        });
        watcher.on('error', () => {
          // Watcher error — fallback polling will handle it.
        });
        folderWatchers.push(watcher);
      } catch {
        // Watch failed — fallback polling will handle it.
      }
    }

    this.watchers.set(folder, { watchers: folderWatchers, refCount: 1 });
  }

  unwatchGroup(folder: string): void {
    const entry = this.watchers.get(folder);
    if (!entry) return;

    entry.refCount--;
    if (entry.refCount > 0) return;

    for (const watcher of entry.watchers) {
      try {
        watcher.close();
      } catch {}
    }
    this.watchers.delete(folder);

    const timer = this.debounceTimers.get(folder);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(folder);
    }
  }

  triggerProcess(folder: string): void {
    this.debouncedProcess(folder);
  }

  startFallback(): void {
    this.fallbackTimer = setInterval(() => {
      if (this.deps.getShuttingDown()) return;
      this.deps.processFull().catch((err) => {
        logger.error({ err }, 'Error in IPC fallback scan');
      });
    }, 5000);
    this.fallbackTimer.unref();
  }

  closeAll(): void {
    for (const [, entry] of this.watchers) {
      for (const watcher of entry.watchers) {
        try {
          watcher.close();
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

  private debouncedProcess(folder: string): void {
    const existing = this.debounceTimers.get(folder);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      folder,
      setTimeout(() => {
        this.debounceTimers.delete(folder);
        if (this.processingFolders.has(folder)) {
          this.pendingReprocess.add(folder);
          return;
        }

        this.processingFolders.add(folder);
        this.deps
          .processGroup(folder)
          .catch((err) => {
            logger.error({ err, folder }, 'Error processing IPC for group');
          })
          .finally(() => {
            this.processingFolders.delete(folder);
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
}

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
  ) {
    return true;
  }
  return false;
}

export function createIpcRuntime(deps: IpcRuntimeDeps): {
  closeAll: () => void;
  startIpcWatcher: () => void;
  unwatchGroup: (folder: string) => void;
  watchGroup: (folder: string) => void;
} {
  let ipcWatcherRunning = false;
  let ipcWatcherManager: IpcWatcherManager | null = null;

  function writeResultFileAtomically(
    resultFilePath: string,
    result: Record<string, unknown>,
  ): void {
    const tmpPath = `${resultFilePath}.tmp`;
    fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(result));
    fs.renameSync(tmpPath, resultFilePath);
  }

  function broadcastToOwnerIMChannels(
    userId: string,
    sourceFolder: string,
    alreadySentJids: Set<string>,
    sendFn: (jid: string) => void,
    notifyChannels?: string[] | null,
  ): void {
    const sentChannelTypes = new Set<string>();
    for (const jid of alreadySentJids) {
      const channelType = deps.getChannelType(jid);
      if (channelType) sentChannelTypes.add(channelType);
    }

    const connectedTypes = deps.getConnectedChannelTypes(userId);
    const ownerGroups = deps.getGroupsByOwner(userId);
    for (const channelType of connectedTypes) {
      if (sentChannelTypes.has(channelType)) continue;
      if (notifyChannels && !notifyChannels.includes(channelType)) continue;

      const target = ownerGroups.find(
        (group) =>
          deps.getChannelType(group.jid) === channelType &&
          group.folder === sourceFolder,
      );
      if (!target) continue;

      sendFn(target.jid);
      sentChannelTypes.add(channelType);
    }
  }

  async function processTaskIpc(
    data: IpcTaskPayload,
    sourceGroup: string,
    isAdminHome: boolean,
    isHome: boolean,
    sourceGroupEntry: RegisteredGroup | undefined,
    ipcAgentId: string | null = null,
  ): Promise<void> {
    switch (data.type) {
      case 'schedule_task':
        if (data.schedule_type && data.schedule_value && data.targetJid) {
          const execType =
            data.execution_type === 'script'
              ? ('script' as const)
              : ('agent' as const);

          if (execType === 'agent' && !data.prompt) {
            logger.warn('schedule_task: agent mode requires prompt');
            break;
          }
          if (execType === 'script' && !data.script_command) {
            logger.warn('schedule_task: script mode requires script_command');
            break;
          }
          if (execType === 'script' && !isAdminHome) {
            logger.warn(
              { sourceGroup },
              'Non-admin container attempted to create script task',
            );
            break;
          }

          const registeredGroups = deps.getRegisteredGroups();
          const targetJid = data.targetJid;
          const targetGroupEntry = registeredGroups[targetJid];
          if (!targetGroupEntry) {
            logger.warn(
              { targetJid },
              'Cannot schedule task: target group not registered',
            );
            break;
          }

          const targetFolder = targetGroupEntry.folder;
          if (!isAdminHome && targetFolder !== sourceGroup) {
            logger.warn(
              { sourceGroup, targetFolder },
              'Unauthorized schedule_task attempt blocked',
            );
            break;
          }

          const scheduleType = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
          let nextRun: string | null = null;

          if (scheduleType === 'cron') {
            try {
              const interval = CronExpressionParser.parse(data.schedule_value, {
                tz: deps.timezone,
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

          const taskId = `task-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const contextMode =
            data.context_mode === 'group' || data.context_mode === 'isolated'
              ? data.context_mode
              : 'isolated';

          deps.createTask({
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
          const task = deps.getTaskById(data.taskId);
          if (task && (isAdminHome || task.group_folder === sourceGroup)) {
            deps.updateTask(data.taskId, { status: 'paused' });
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
          const task = deps.getTaskById(data.taskId);
          if (task && (isAdminHome || task.group_folder === sourceGroup)) {
            deps.updateTask(data.taskId, { status: 'active' });
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
          const task = deps.getTaskById(data.taskId);
          if (task && (isAdminHome || task.group_folder === sourceGroup)) {
            deps.deleteTask(data.taskId);
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

          const listTasksDir = path.join(
            deps.dataDir,
            'ipc',
            sourceGroup,
            'tasks',
          );
          const listTasksDirResolved = path.resolve(listTasksDir);
          const resultFilePath = path.resolve(
            listTasksDir,
            `list_tasks_result_${requestId}.json`,
          );
          if (
            !resultFilePath.startsWith(`${listTasksDirResolved}${path.sep}`)
          ) {
            logger.warn(
              { sourceGroup, requestId, resultFilePath },
              'Rejected list_tasks request with unsafe result file path',
            );
            break;
          }

          try {
            const allTasks = deps.getAllTasks();
            const filteredTasks = isAdminHome
              ? allTasks
              : allTasks.filter((task) => task.group_folder === sourceGroup);
            const taskList = filteredTasks.map((task) => ({
              id: task.id,
              groupFolder: task.group_folder,
              prompt: task.prompt,
              schedule_type: task.schedule_type,
              schedule_value: task.schedule_value,
              status: task.status,
              next_run: task.next_run,
            }));
            writeResultFileAtomically(resultFilePath, {
              success: true,
              tasks: taskList,
            });
            logger.debug(
              { sourceGroup, taskCount: taskList.length },
              'Task list sent via IPC',
            );
          } catch (err) {
            writeResultFileAtomically(resultFilePath, {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
            logger.error({ sourceGroup, err }, 'Failed to list tasks via IPC');
          }
        }
        break;

      case 'refresh_groups':
        if (isAdminHome) {
          logger.info(
            { sourceGroup },
            'Group metadata refresh requested via IPC',
          );
          await deps.syncGroupMetadata(true);
          deps.writeGroupsSnapshot(
            sourceGroup,
            true,
            deps.getAvailableGroups(),
            new Set(Object.keys(deps.getRegisteredGroups())),
          );
        } else {
          logger.warn(
            { sourceGroup },
            'Unauthorized refresh_groups attempt blocked',
          );
        }
        break;

      case 'register_group':
        if (!isAdminHome) {
          logger.warn(
            { sourceGroup },
            'Unauthorized register_group attempt blocked',
          );
          break;
        }

        if (data.jid && data.name && data.folder) {
          const sourceEntry = Object.values(deps.getRegisteredGroups()).find(
            (group) => group.folder === sourceGroup,
          );
          const execMode =
            data.executionMode === 'host' || data.executionMode === 'container'
              ? data.executionMode
              : undefined;

          deps.registerGroup(data.jid, {
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

          const tasksDir = path.join(deps.dataDir, 'ipc', sourceGroup, 'tasks');
          const tasksDirResolved = path.resolve(tasksDir);
          const resultFilePath = path.resolve(
            tasksDir,
            `install_skill_result_${requestId}.json`,
          );
          if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
            logger.warn(
              { sourceGroup, requestId, resultFilePath },
              'Rejected install_skill request with unsafe result file path',
            );
            break;
          }

          const sourceGroupForSkill = Object.values(
            deps.getRegisteredGroups(),
          ).find((group) => group.folder === sourceGroup);
          const userId = sourceGroupForSkill?.created_by;
          if (!userId) {
            logger.warn(
              { sourceGroup },
              'Cannot install skill: no user associated with group',
            );
            writeResultFileAtomically(resultFilePath, {
              success: false,
              error: 'No user associated with this group',
            });
            break;
          }

          try {
            const result = await deps.installSkillForUser(userId, pkg);
            writeResultFileAtomically(resultFilePath, result);
            logger.info(
              { sourceGroup, userId, pkg, success: result.success },
              'Skill installation via IPC completed',
            );
          } catch (err) {
            writeResultFileAtomically(resultFilePath, {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
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

          const tasksDir = path.join(deps.dataDir, 'ipc', sourceGroup, 'tasks');
          const tasksDirResolved = path.resolve(tasksDir);
          const resultFilePath = path.resolve(
            tasksDir,
            `uninstall_skill_result_${requestId}.json`,
          );
          if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
            logger.warn(
              { sourceGroup, requestId, resultFilePath },
              'Rejected uninstall_skill request with unsafe result file path',
            );
            break;
          }

          const sourceGroupForUninstall = Object.values(
            deps.getRegisteredGroups(),
          ).find((group) => group.folder === sourceGroup);
          const userId = sourceGroupForUninstall?.created_by;
          if (!userId) {
            logger.warn(
              { sourceGroup },
              'Cannot uninstall skill: no user associated with group',
            );
            writeResultFileAtomically(resultFilePath, {
              success: false,
              error: 'No user associated with this group',
            });
            break;
          }

          const result = deps.deleteSkillForUser(userId, skillId);
          writeResultFileAtomically(resultFilePath, result);
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
          const registeredGroups = deps.getRegisteredGroups();
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
            const fullPath = path.join(
              deps.groupsDir,
              sourceGroup,
              data.filePath,
            );
            const resolvedPath = path.resolve(fullPath);
            const safeRoot =
              path.resolve(deps.groupsDir, sourceGroup) + path.sep;
            if (!resolvedPath.startsWith(safeRoot)) {
              logger.warn(
                { sourceGroup, filePath: data.filePath, resolvedPath },
                'Path traversal attempt blocked in send_file IPC',
              );
              break;
            }

            const fileImRoute = ipcAgentId
              ? null
              : deps.getChannelType(data.chatJid) !== null
                ? data.chatJid
                : (deps.getActiveImReplyRoute(sourceGroup) ?? null);
            if (fileImRoute) {
              const imFileName = data.fileName || path.basename(resolvedPath);
              await deps.retryImOperation('send_file', fileImRoute, () =>
                deps.sendFile(fileImRoute, resolvedPath, imFileName),
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

  function watchGroup(folder: string): void {
    ipcWatcherManager?.watchGroup(folder);
  }

  function unwatchGroup(folder: string): void {
    ipcWatcherManager?.unwatchGroup(folder);
  }

  function closeAll(): void {
    ipcWatcherManager?.closeAll();
    ipcWatcherManager = null;
    ipcWatcherRunning = false;
  }

  function startIpcWatcher(): void {
    if (ipcWatcherRunning) {
      logger.debug('IPC watcher already running, skipping duplicate start');
      return;
    }
    ipcWatcherRunning = true;

    const ipcBaseDir = path.join(deps.dataDir, 'ipc');
    fs.mkdirSync(ipcBaseDir, { recursive: true });
    const fsp = fs.promises;

    const processGroupIpc = async (sourceGroup: string) => {
      if (deps.getShuttingDown()) return;

      const registeredGroups = deps.getRegisteredGroups();
      const sourceGroupEntry = Object.values(registeredGroups).find(
        (group) => group.folder === sourceGroup,
      );
      const isAdminHome = !!(
        sourceGroupEntry?.is_home && sourceGroup === deps.mainGroupFolder
      );
      const isHome = !!sourceGroupEntry?.is_home;

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
          if (!entry.isDirectory()) continue;
          ipcRoots.push({
            path: path.join(agentsDir, entry.name),
            agentId: entry.name,
            taskId: null,
          });
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
          if (!entry.isDirectory()) continue;
          ipcRoots.push({
            path: path.join(tasksRunDir, entry.name),
            agentId: null,
            taskId: entry.name,
          });
        }
      } catch {
        /* tasks-run dir may not exist */
      }

      for (const ipcRootEntry of ipcRoots) {
        const {
          path: ipcRoot,
          agentId: ipcAgentId,
          taskId: ipcTaskId,
        } = ipcRootEntry;
        const messagesDir = path.join(ipcRoot, 'messages');
        const tasksDir = path.join(ipcRoot, 'tasks');

        try {
          const messageEntries = await fsp.readdir(messagesDir);
          const messageFiles = messageEntries.filter((file) =>
            file.endsWith('.json'),
          );

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
                  const effectiveChatJid = ipcAgentId
                    ? `${data.chatJid}#agent:${ipcAgentId}`
                    : data.chatJid;
                  await deps.sendMessage(effectiveChatJid, data.text, {
                    messageMeta: {
                      sourceKind: 'sdk_send_message',
                    },
                  });

                  if (!ipcAgentId) {
                    const ipcImRoute = deps.getActiveImReplyRoute(sourceGroup);
                    if (
                      ipcImRoute &&
                      deps.getChannelType(data.chatJid) === null &&
                      ipcImRoute !== data.chatJid
                    ) {
                      const localImages = deps.extractLocalImImagePaths(
                        data.text,
                        sourceGroup,
                      );
                      deps.sendImWithFailTracking(
                        ipcImRoute,
                        data.text,
                        localImages,
                      );
                    }

                    if (data.isScheduledTask && sourceGroupEntry?.created_by) {
                      const alreadySent = new Set<string>(
                        [data.chatJid, ipcImRoute].filter(Boolean) as string[],
                      );
                      const taskLocalImages = deps.extractLocalImImagePaths(
                        data.text,
                        sourceGroup,
                      );
                      let taskNotifyChannels: string[] | null | undefined;
                      if (ipcTaskId) {
                        const taskRecord = deps.getTaskById(ipcTaskId);
                        taskNotifyChannels = taskRecord?.notify_channels;
                      }
                      broadcastToOwnerIMChannels(
                        sourceGroupEntry.created_by,
                        sourceGroup,
                        alreadySent,
                        (jid) =>
                          deps.sendImWithFailTracking(
                            jid,
                            data.text,
                            taskLocalImages,
                          ),
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

                    const imgImRoute = ipcAgentId
                      ? null
                      : deps.getChannelType(data.chatJid) !== null
                        ? data.chatJid
                        : (deps.getActiveImReplyRoute(sourceGroup) ?? null);
                    if (imgImRoute) {
                      await deps.retryImOperation(
                        'send_image',
                        imgImRoute,
                        () =>
                          deps.sendImage(
                            imgImRoute,
                            imageBuffer,
                            mimeType,
                            caption,
                            fileName,
                          ),
                      );
                    }

                    const imgChatJid = ipcAgentId
                      ? `${data.chatJid}#agent:${ipcAgentId}`
                      : data.chatJid;
                    const displayText = caption
                      ? `[图片: ${fileName || 'image'}]\n${caption}`
                      : `[图片: ${fileName || 'image'}]`;
                    const imgMsgId = crypto.randomUUID();
                    const imgTimestamp = new Date().toISOString();
                    deps.ensureChatExists(imgChatJid);
                    const persistedImgMsgId = deps.storeMessageDirect(
                      imgMsgId,
                      imgChatJid,
                      'happypaw-agent',
                      deps.assistantName,
                      displayText,
                      imgTimestamp,
                      true,
                      { meta: { sourceKind: 'sdk_send_message' } },
                    );
                    deps.broadcastNewMessage(imgChatJid, {
                      id: persistedImgMsgId,
                      chat_jid: imgChatJid,
                      sender: 'happypaw-agent',
                      sender_name: deps.assistantName,
                      content: displayText,
                      timestamp: imgTimestamp,
                      is_from_me: true,
                      turn_id: null,
                      session_id: null,
                      sdk_message_uuid: null,
                      source_kind: 'sdk_send_message',
                      finalization_reason: null,
                    });
                    deps.broadcastToWebClients(imgChatJid, displayText);

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
                        const imgTaskRecord = deps.getTaskById(ipcTaskId);
                        imgTaskNotifyChannels = imgTaskRecord?.notify_channels;
                      }
                      broadcastToOwnerIMChannels(
                        sourceGroupEntry.created_by,
                        sourceGroup,
                        alreadySent,
                        (jid) =>
                          deps
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

        try {
          const allEntries = await fsp.readdir(tasksDir, {
            withFileTypes: true,
          });

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
              const data = JSON.parse(raw) as IpcTaskPayload;
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
      }
    };

    const processIpcFilesFull = async () => {
      if (deps.getShuttingDown()) return;

      let groupFolders: string[];
      try {
        const entries = await fsp.readdir(ipcBaseDir, { withFileTypes: true });
        groupFolders = entries
          .filter((entry) => entry.isDirectory() && entry.name !== 'errors')
          .map((entry) => entry.name);
      } catch (err) {
        logger.error({ err }, 'Error reading IPC base directory');
        return;
      }

      for (const sourceGroup of groupFolders) {
        ipcWatcherManager?.triggerProcess(sourceGroup);
      }
    };

    ipcWatcherManager = new IpcWatcherManager({
      dataDir: deps.dataDir,
      getShuttingDown: deps.getShuttingDown,
      processGroup: processGroupIpc,
      processFull: processIpcFilesFull,
    });

    processIpcFilesFull().catch((err) => {
      logger.error({ err }, 'Error in initial IPC scan');
    });
    ipcWatcherManager.startFallback();

    logger.info('IPC watcher started (event-driven + 5s fallback)');
  }

  return {
    closeAll,
    startIpcWatcher,
    unwatchGroup,
    watchGroup,
  };
}

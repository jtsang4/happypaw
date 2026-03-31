import crypto from 'crypto';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER } from '../../app/config.js';
import {
  addGroupMember,
  createAgent,
  ensureChatExists,
  getAgent,
  getGroupsByOwner,
  getJidsByFolder,
  getMessagesPage,
  getRegisteredGroup,
  getUserById,
  getUserHomeGroup,
  listAgentsByJid,
  setRegisteredGroup,
  storeMessageDirect,
  updateChatName,
} from '../../db.js';
import {
  formatContextMessages,
  getRecallCommandUnavailableMessage,
  formatSystemStatus,
  formatWorkspaceList,
  resolveLocationInfo,
  type WorkspaceInfo,
} from '../im/commands/im-command-utils.js';
import { logger } from '../../app/logger.js';
import { ensureAgentDirectories } from '../agents/agent-directories.js';
import { stripVirtualJidSuffix } from '../../shared/im/virtual-jid.js';
import { broadcastAgentStatus, broadcastNewMessage } from '../../web.js';
import { getSystemSettings } from '../../runtime-config.js';
import { executeSessionReset } from './commands.js';
import type {
  MessageCursor,
  RegisteredGroup,
  RuntimeSessionRecord,
  SubAgent,
} from '../../shared/types.js';
import type { GroupQueue } from './group-queue.js';

const DEFAULT_MAIN_JID = 'web:main';
const DEFAULT_MAIN_NAME = 'Main';

interface CommandDeps {
  queue: GroupQueue;
  sessions: Record<string, RuntimeSessionRecord>;
  registeredGroups: Record<string, RegisteredGroup>;
  imSendFailCounts: Map<string, number>;
  imHealthCheckFailCounts: Map<string, number>;
  setCursors: (jid: string, cursor: MessageCursor) => void;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  unbindImGroup: (jid: string, reason: string) => void;
  resolveEffectiveGroup: (group: RegisteredGroup) => {
    effectiveGroup: RegisteredGroup;
    isHome: boolean;
  };
  processAgentConversation: (chatJid: string, agentId: string) => Promise<void>;
}

interface SpawnWorkspace {
  homeChatJid: string;
  homeGroup: RegisteredGroup;
  effectiveGroup: RegisteredGroup;
}

export function createSlashCommandHandlers(deps: CommandDeps): {
  handleCommand: (chatJid: string, command: string) => Promise<string | null>;
  handleSpawnCommand: (
    chatJid: string,
    rawMessage: string,
    sourceImJid?: string,
  ) => Promise<string>;
} {
  function collectWorkspaces(userId: string): WorkspaceInfo[] {
    const ownedGroups = getGroupsByOwner(userId);
    const user = getUserById(userId);
    const isAdmin = user?.role === 'admin';

    const seen = new Set<string>();
    const workspaces: WorkspaceInfo[] = [];

    for (const g of ownedGroups) {
      if (!g.jid.startsWith('web:')) continue;
      if (seen.has(g.folder)) continue;
      seen.add(g.folder);

      const agents = listAgentsByJid(g.jid)
        .filter((a) => a.kind === 'conversation')
        .map((a) => ({ id: a.id, name: a.name, status: a.status }));

      workspaces.push({ folder: g.folder, name: g.name, agents });
    }

    if (isAdmin && !seen.has(MAIN_GROUP_FOLDER)) {
      const agents = listAgentsByJid(DEFAULT_MAIN_JID)
        .filter((a) => a.kind === 'conversation')
        .map((a) => ({ id: a.id, name: a.name, status: a.status }));
      workspaces.push({
        folder: MAIN_GROUP_FOLDER,
        name: DEFAULT_MAIN_NAME,
        agents,
      });
    }

    return workspaces;
  }

  function findWebJidForFolder(folder: string): string | null {
    for (const [jid, group] of Object.entries(deps.registeredGroups)) {
      if (group.folder === folder && jid.startsWith('web:')) return jid;
    }
    const jids = getJidsByFolder(folder);
    for (const jid of jids) {
      if (jid.startsWith('web:')) return jid;
    }
    return null;
  }

  function findGroupNameByFolder(folder: string): string {
    const webJid = findWebJidForFolder(folder);
    if (webJid) {
      const group = deps.registeredGroups[webJid] ?? getRegisteredGroup(webJid);
      if (group) return group.name;
    }
    return folder;
  }

  function getConversationContext(
    folder: string,
    agentId: string | null,
    count = 5,
    maxLen = 80,
  ): string {
    const webJid = findWebJidForFolder(folder);
    if (!webJid) return '';

    const chatJidForMsg = agentId ? `${webJid}#agent:${agentId}` : webJid;
    const messages = getMessagesPage(chatJidForMsg, undefined, count);

    if (messages.length === 0) return '\n\n📭 该对话暂无消息记录';

    const formatted = formatContextMessages(messages.reverse(), maxLen);
    return formatted || '\n\n📭 该对话暂无消息记录';
  }

  function resolveBindingTarget(
    userId: string,
    rawSpec: string,
  ): {
    target_agent_id?: string;
    target_main_jid?: string;
    display: string;
  } | null {
    const spec = rawSpec.trim();
    if (!spec) return null;

    const [workspaceSpecRaw, agentSpecRaw] = spec.split('/', 2);
    const workspaceSpec = workspaceSpecRaw.trim().toLowerCase();
    const agentSpec = agentSpecRaw?.trim().toLowerCase();
    const workspaces = collectWorkspaces(userId);
    const workspace = workspaces.find(
      (ws) =>
        ws.folder.toLowerCase() === workspaceSpec ||
        ws.name.trim().toLowerCase() === workspaceSpec,
    );
    if (!workspace) return null;

    if (!agentSpec || agentSpec === 'main' || agentSpec === '主对话') {
      const mainJid = findWebJidForFolder(workspace.folder);
      if (!mainJid) return null;
      return {
        target_main_jid: mainJid,
        display: `${workspace.name} / 主对话`,
      };
    }

    const agent = workspace.agents.find(
      (item) =>
        item.id.toLowerCase().startsWith(agentSpec) ||
        item.name.trim().toLowerCase() === agentSpec,
    );
    if (!agent) return null;

    return {
      target_agent_id: agent.id,
      display: `${workspace.name} / ${agent.name}`,
    };
  }

  async function handleClearCommand(chatJid: string): Promise<string> {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return '未找到当前工作区';

    const agentId = group.target_agent_id || undefined;
    const agentBaseJid = agentId
      ? (getAgent(agentId)?.chat_jid ?? undefined)
      : undefined;
    const effectiveJid =
      group.target_main_jid && !agentId
        ? group.target_main_jid
        : agentBaseJid || chatJid;

    try {
      await executeSessionReset(
        effectiveJid,
        group.folder,
        {
          queue: deps.queue,
          sessions: deps.sessions,
          broadcast: broadcastNewMessage,
          setLastAgentTimestamp: deps.setCursors,
        },
        agentId,
      );
      return '已清除对话上下文 ✓';
    } catch (err) {
      logger.error({ chatJid, agentId, err }, 'handleCommand /clear failed');
      return '清除上下文失败，请稍后重试';
    }
  }

  function handleListCommand(chatJid: string): string {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return '当前 IM 未绑定工作区';

    const userId = group.created_by;
    if (!userId) return '无法确定用户身份';

    const workspaces = collectWorkspaces(userId);
    if (workspaces.length === 0) return '没有可用的工作区';

    const lookupGroup = (jid: string) =>
      deps.registeredGroups[jid] ?? getRegisteredGroup(jid);
    const location = resolveLocationInfo(
      group,
      lookupGroup,
      getAgent,
      findGroupNameByFolder,
    );

    const currentAgentId = group.target_agent_id ?? null;
    const currentOnMain = !currentAgentId;

    return (
      formatWorkspaceList(
        workspaces,
        location.folder,
        currentAgentId,
        currentOnMain,
      ) + '\n💡 使用 /bind <workspace> 或 /bind <workspace>/<agent短ID>'
    );
  }

  function handleStatusCommand(chatJid: string): string {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return '当前 IM 未绑定工作区';

    const lookupGroup = (jid: string) =>
      deps.registeredGroups[jid] ?? getRegisteredGroup(jid);
    const location = resolveLocationInfo(
      group,
      lookupGroup,
      getAgent,
      findGroupNameByFolder,
    );

    const queueStatus = deps.queue.getStatus();
    const settings = getSystemSettings();

    const groupState = queueStatus.groups.find((g) => {
      const rg = lookupGroup(g.jid);
      return rg?.folder === location.folder;
    });
    const isActive = !!groupState?.active;
    const queuePosition =
      !isActive && queueStatus.waitingGroupJids.includes(chatJid)
        ? queueStatus.waitingGroupJids.indexOf(chatJid) + 1
        : null;

    return formatSystemStatus(
      location,
      {
        activeContainerCount: queueStatus.activeContainerCount,
        activeHostProcessCount: queueStatus.activeHostProcessCount,
        maxContainers: settings.maxConcurrentContainers,
        maxHostProcesses: settings.maxConcurrentHostProcesses,
        waitingCount: queueStatus.waitingCount,
        waitingGroupJids: queueStatus.waitingGroupJids,
      },
      isActive,
      queuePosition,
    );
  }

  function handleWhereCommand(chatJid: string): string {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return '当前 IM 未绑定工作区';

    const lookupGroup = (jid: string) =>
      deps.registeredGroups[jid] ?? getRegisteredGroup(jid);
    const location = resolveLocationInfo(
      group,
      lookupGroup,
      getAgent,
      findGroupNameByFolder,
    );

    const lines = [`📍 当前绑定: ${location.locationLine}`];
    if (location.replyPolicy) {
      lines.push(`🔁 回复策略: ${location.replyPolicy}`);
    }
    return lines.join('\n');
  }

  function handleUnbindCommand(chatJid: string): string {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return '当前 IM 未绑定工作区';
    if (!group.target_agent_id && !group.target_main_jid) {
      return '当前聊天没有额外绑定，已在默认工作区。';
    }
    deps.unbindImGroup(chatJid, 'IM slash command unbind');
    return '已解绑，后续消息将回到该聊天自己的默认工作区。';
  }

  function handleBindCommand(chatJid: string, rawSpec: string): string {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return '当前 IM 未绑定工作区';
    const userId = group.created_by;
    if (!userId) return '无法确定当前聊天所属用户';
    if (!rawSpec) {
      return '用法: /bind <workspace> 或 /bind <workspace>/<agent短ID>';
    }

    const resolved = resolveBindingTarget(userId, rawSpec);
    if (!resolved) {
      return '未找到目标。先用 /list 查看工作区和 agent 短 ID，再执行 /bind <workspace>/<agent短ID>';
    }

    const updated: RegisteredGroup = {
      ...group,
      target_agent_id: resolved.target_agent_id,
      target_main_jid: resolved.target_main_jid,
      reply_policy: 'source_only',
    };
    setRegisteredGroup(chatJid, updated);
    deps.registeredGroups[chatJid] = updated;
    deps.imSendFailCounts.delete(chatJid);
    deps.imHealthCheckFailCounts.delete(chatJid);
    return `已切换到 ${resolved.display}\n🔁 回复策略: source_only`;
  }

  async function handleNewCommand(
    chatJid: string,
    rawArgs: string,
  ): Promise<string> {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return '当前 IM 未绑定工作区';
    const userId = group.created_by;
    if (!userId) return '无法确定当前聊天所属用户';

    const trimmedArgs = rawArgs.trim();
    if (!trimmedArgs) {
      return '用法: /new <工作区名称> 或 /new <host|container> <工作区名称>';
    }

    let executionMode: 'container' | 'host' = 'container';
    let name = trimmedArgs;
    const [firstToken, ...restTokens] = trimmedArgs.split(/\s+/);
    const normalizedFirstToken = firstToken?.toLowerCase();
    if (
      (normalizedFirstToken === 'host' ||
        normalizedFirstToken === 'container') &&
      restTokens.length > 0
    ) {
      executionMode = normalizedFirstToken;
      name = restTokens.join(' ').trim();
    }

    if (executionMode === 'host' && getUserById(userId)?.role !== 'admin') {
      return '只有管理员可以通过 /new host 创建宿主机模式工作区';
    }
    if (name.length > 50) return '名称过长（最多 50 字符）';

    const newJid = `web:${crypto.randomUUID()}`;
    const folder = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    const newGroup: RegisteredGroup = {
      name,
      folder,
      added_at: now,
      executionMode,
      created_by: userId,
    };

    deps.registerGroup(newJid, newGroup);
    ensureChatExists(newJid);
    updateChatName(newJid, name);
    addGroupMember(folder, userId, 'owner', userId);

    const updated: RegisteredGroup = {
      ...group,
      target_main_jid: newJid,
      target_agent_id: undefined,
      reply_policy: 'source_only',
    };
    setRegisteredGroup(chatJid, updated);
    deps.registeredGroups[chatJid] = updated;
    deps.imSendFailCounts.delete(chatJid);
    deps.imHealthCheckFailCounts.delete(chatJid);

    return `工作区「${name}」已创建并绑定\n📁 ${folder}\n🖥️ 模式: ${executionMode}\n🔁 回复策略: source_only\n\n发送 /unbind 可解绑回默认工作区`;
  }

  function handleRequireMentionCommand(
    chatJid: string,
    rawArgs: string,
  ): string {
    const group = deps.registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return '未找到当前会话';

    const action = rawArgs.trim().toLowerCase();
    if (action === 'true') {
      const updated: RegisteredGroup = { ...group, require_mention: true };
      setRegisteredGroup(chatJid, updated);
      deps.registeredGroups[chatJid] = updated;
      return '已开启：群聊中需要 @机器人 才会响应';
    } else if (action === 'false') {
      const updated: RegisteredGroup = { ...group, require_mention: false };
      setRegisteredGroup(chatJid, updated);
      deps.registeredGroups[chatJid] = updated;
      return '已关闭：群聊中所有消息都会响应，无需 @机器人';
    } else if (!action) {
      const current = group.require_mention === true;
      return `当前 require_mention: ${current}\n\n用法:\n/require_mention true — 需要 @机器人\n/require_mention false — 全量响应`;
    }
    return '用法: /require_mention true|false';
  }

  async function handleRecallCommand(chatJid: string): Promise<string> {
    logger.info({ chatJid }, '/recall command received');
    return getRecallCommandUnavailableMessage();
  }

  function resolveSpawnWorkspace(
    baseJid: string,
    group: RegisteredGroup,
    userId: string,
  ): SpawnWorkspace | string {
    let homeChatJid: string;
    let homeGroup: RegisteredGroup;

    if (group.target_main_jid) {
      const target =
        deps.registeredGroups[group.target_main_jid] ??
        getRegisteredGroup(group.target_main_jid);
      if (!target) return '绑定的工作区不存在';
      homeChatJid = group.target_main_jid;
      homeGroup = target;
    } else if (group.target_agent_id) {
      const agentInfo = getAgent(group.target_agent_id);
      if (!agentInfo) return '绑定的 Agent 不存在';
      const parent =
        deps.registeredGroups[agentInfo.chat_jid] ??
        getRegisteredGroup(agentInfo.chat_jid);
      if (!parent) return '绑定 Agent 所属的工作区不存在';
      homeChatJid = agentInfo.chat_jid;
      homeGroup = parent;
    } else if (baseJid.startsWith('web:')) {
      homeChatJid = baseJid;
      homeGroup = group;
    } else {
      const userHome = getUserHomeGroup(userId);
      if (!userHome) return '未找到用户主工作区';
      homeChatJid = `web:${userHome.folder}`;
      const homeJids = getJidsByFolder(userHome.folder);
      const webJid = homeJids.find((j) => j.startsWith('web:')) ?? homeJids[0];
      const resolvedHome = webJid
        ? (deps.registeredGroups[webJid] ?? getRegisteredGroup(webJid))
        : undefined;
      if (!resolvedHome) return '未找到用户主工作区';
      homeGroup = resolvedHome;
    }

    const { effectiveGroup } = deps.resolveEffectiveGroup(homeGroup);
    return { homeChatJid, homeGroup, effectiveGroup };
  }

  async function handleSpawnCommand(
    chatJid: string,
    rawMessage: string,
    sourceImJid?: string,
  ): Promise<string> {
    const message = rawMessage.trim();
    if (!message) return '用法: /sw <任务描述>\n在当前工作区创建并行任务';

    const baseJid = stripVirtualJidSuffix(chatJid);
    const group = deps.registeredGroups[baseJid] ?? getRegisteredGroup(baseJid);
    if (!group) return '未找到当前工作区';
    const userId = group.created_by;
    if (!userId) return '无法确定当前聊天所属用户';

    const resolved = resolveSpawnWorkspace(baseJid, group, userId);
    if (typeof resolved === 'string') return resolved;
    const { homeChatJid, effectiveGroup } = resolved;

    const spawnedFromJid = sourceImJid ? homeChatJid : chatJid;

    const now = new Date().toISOString();
    const agentId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const user = getUserById(userId);
    const senderName = user?.display_name || user?.username || userId;
    const truncatedName =
      message.length > 30 ? message.slice(0, 30) + '…' : message;
    const agentName = `⚡ ${truncatedName}`;

    const newAgent: SubAgent = {
      id: agentId,
      group_folder: effectiveGroup.folder,
      chat_jid: homeChatJid,
      name: agentName,
      prompt: '',
      status: 'idle',
      kind: 'spawn',
      created_by: userId,
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: sourceImJid ?? null,
      spawned_from_jid: spawnedFromJid,
    };
    createAgent(newAgent);

    ensureAgentDirectories(effectiveGroup.folder, agentId);

    const virtualChatJid = `${homeChatJid}#agent:${agentId}`;
    ensureChatExists(virtualChatJid);
    updateChatName(virtualChatJid, agentName);
    storeMessageDirect(
      messageId,
      virtualChatJid,
      userId,
      senderName,
      message,
      now,
      false,
      sourceImJid ? { sourceJid: sourceImJid } : undefined,
    );
    broadcastNewMessage(virtualChatJid, {
      id: messageId,
      chat_jid: virtualChatJid,
      sender: userId,
      sender_name: senderName,
      content: message,
      timestamp: now,
      is_from_me: false,
    });

    broadcastAgentStatus(
      homeChatJid,
      agentId,
      'idle',
      agentName,
      '',
      undefined,
      'spawn',
    );

    if (sourceImJid) {
      ensureChatExists(homeChatJid);
      const cmdId = crypto.randomUUID();
      storeMessageDirect(
        cmdId,
        homeChatJid,
        userId,
        senderName,
        `/sw ${message}`,
        now,
        false,
        {
          meta: { sourceKind: 'user_command' },
        },
      );
      broadcastNewMessage(homeChatJid, {
        id: cmdId,
        chat_jid: homeChatJid,
        sender: userId,
        sender_name: senderName,
        content: `/sw ${message}`,
        timestamp: now,
        is_from_me: false,
      });
    }

    const taskId = `spawn:${agentId}:${Date.now()}`;
    deps.queue.enqueueTask(virtualChatJid, taskId, async () => {
      await deps.processAgentConversation(homeChatJid, agentId);
    });

    logger.info(
      {
        chatJid,
        homeChatJid,
        agentId,
        userId,
        sourceImJid,
        folder: effectiveGroup.folder,
      },
      '/spawn command: agent created and enqueued',
    );

    const shortId = agentId.slice(0, 4);
    return `⚡ 并行任务已启动 [${shortId}]: ${truncatedName}`;
  }

  async function handleCommand(
    chatJid: string,
    command: string,
  ): Promise<string | null> {
    const parts = command.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rawArgs = command.slice(parts[0].length).trim();

    switch (cmd) {
      case 'clear':
        return handleClearCommand(chatJid);
      case 'list':
      case 'ls':
        return handleListCommand(chatJid);
      case 'status':
        return handleStatusCommand(chatJid);
      case 'recall':
      case 'rc':
        return handleRecallCommand(chatJid);
      case 'where':
        return handleWhereCommand(chatJid);
      case 'unbind':
        return handleUnbindCommand(chatJid);
      case 'bind':
        return handleBindCommand(chatJid, rawArgs);
      case 'new':
        return handleNewCommand(chatJid, rawArgs);
      case 'require_mention':
        return handleRequireMentionCommand(chatJid, rawArgs);
      case 'sw':
      case 'spawn':
        return handleSpawnCommand(chatJid, rawArgs, chatJid);
      default:
        return null;
    }
  }

  return {
    handleCommand,
    handleSpawnCommand,
  };
}

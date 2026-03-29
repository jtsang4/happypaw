import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { promisify } from 'util';

import { Hono } from 'hono';
import type { Variables } from '../../../app/web/context.js';
import {
  authMiddleware,
  systemConfigMiddleware,
} from '../../../middleware/auth.js';
import type { AuthUser } from '../../../shared/types.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
  getWebDeps,
} from '../../../app/web/context.js';
import { getRegisteredGroup, getRouterState } from '../../../db.js';
import {
  getPinnedCodexBinaryConfig,
  getPinnedCodexContainerExecutablePath,
  getPinnedCodexRepoCacheRoot,
  resolvePinnedCodexHostBinary,
} from '../../execution/codex-binary.js';
import { CONTAINER_IMAGE } from '../../../app/config.js';
import {
  getCodexProviderConfigWithSource,
  getSystemSettings,
} from '../../../runtime-config.js';
import { logger } from '../../../app/logger.js';

const execFileAsync = promisify(execFile);

interface HelperReadinessInfo {
  ready: boolean;
  detail: string;
}

interface CodexDiagnostics {
  pinnedVersion: string;
  releaseTag: string;
  releaseSource: string;
  repoCache: {
    executablePath: string | null;
    prepared: boolean;
  };
  hostBootstrap: {
    executablePath: string | null;
    cached: boolean;
  };
  containerBundle: {
    executablePath: string;
    imageReady: boolean;
  };
  helperReadiness: {
    taskParsing: HelperReadinessInfo;
    bugReportGeneration: HelperReadinessInfo;
    githubIssueSubmission: HelperReadinessInfo;
  };
}

let cachedGithubIssueSubmission: {
  info: HelperReadinessInfo;
  fetchedAt: number;
} | null = null;
const GITHUB_HELPER_CACHE_TTL = 5 * 60 * 1000;

function describePinnedCodexBinary(cacheRoot?: string): {
  executablePath: string | null;
  cached: boolean;
} {
  try {
    const resolved = resolvePinnedCodexHostBinary(
      cacheRoot ? { cacheRoot } : undefined,
    );
    return {
      executablePath: resolved.executablePath,
      cached: fs.existsSync(resolved.executablePath),
    };
  } catch {
    return {
      executablePath: null,
      cached: false,
    };
  }
}

function getCodexHelperDiagnostics(): Pick<
  CodexDiagnostics['helperReadiness'],
  'taskParsing' | 'bugReportGeneration'
> {
  const { config } = getCodexProviderConfigWithSource();
  const codexConfigured = !!config.openaiApiKey.trim();
  const detail = codexConfigured
    ? 'Codex API Key 已配置，可调用 Codex helper'
    : '尚未配置 Codex API Key，相关 helper 将回退到显式降级路径';

  return {
    taskParsing: {
      ready: codexConfigured,
      detail: codexConfigured
        ? '任务解析助手已就绪'
        : `任务解析助手未就绪：${detail}`,
    },
    bugReportGeneration: {
      ready: codexConfigured,
      detail: codexConfigured
        ? 'Bug 报告分析助手已就绪'
        : `Bug 报告分析助手未就绪：${detail}`,
    },
  };
}

async function getGithubIssueSubmissionDiagnostic(): Promise<HelperReadinessInfo> {
  const now = Date.now();
  if (
    cachedGithubIssueSubmission &&
    now - cachedGithubIssueSubmission.fetchedAt < GITHUB_HELPER_CACHE_TTL
  ) {
    return cachedGithubIssueSubmission.info;
  }

  let info: HelperReadinessInfo;
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 });
    info = {
      ready: true,
      detail: 'gh 已登录，可直接提交 GitHub Issue',
    };
  } catch {
    info = {
      ready: false,
      detail: 'gh 未登录，将回退到预填 Issue 链接',
    };
  }

  cachedGithubIssueSubmission = { info, fetchedAt: now };
  return info;
}

async function getCodexDiagnostics(
  dockerImageExists: boolean,
): Promise<CodexDiagnostics> {
  const pinnedConfig = getPinnedCodexBinaryConfig();
  const repoBinary = describePinnedCodexBinary(getPinnedCodexRepoCacheRoot());
  const hostBinary = describePinnedCodexBinary();
  const helperDiagnostics = getCodexHelperDiagnostics();

  return {
    pinnedVersion: pinnedConfig.version,
    releaseTag: pinnedConfig.releaseTag,
    releaseSource: `GitHub Releases · ${pinnedConfig.releaseRepo}`,
    repoCache: {
      executablePath: repoBinary.executablePath,
      prepared: repoBinary.cached,
    },
    hostBootstrap: {
      executablePath: hostBinary.executablePath,
      cached: hostBinary.cached,
    },
    containerBundle: {
      executablePath: getPinnedCodexContainerExecutablePath(),
      imageReady: dockerImageExists,
    },
    helperReadiness: {
      ...helperDiagnostics,
      githubIssueSubmission: await getGithubIssueSubmissionDiagnostic(),
    },
  };
}

// --- Docker build state ---

let buildState: {
  building: boolean;
  startedAt: number | null;
  startedBy: string | null;
  logs: string[];
  result: { success: boolean; error?: string } | null;
} = {
  building: false,
  startedAt: null,
  startedBy: null,
  logs: [],
  result: null,
};

// --- Dependency injection (avoid circular imports) ---

let broadcastLog: ((line: string) => void) | null = null;
let broadcastComplete: ((success: boolean, error?: string) => void) | null =
  null;

export function injectMonitorDeps(deps: {
  broadcastDockerBuildLog: (line: string) => void;
  broadcastDockerBuildComplete: (success: boolean, error?: string) => void;
}) {
  broadcastLog = deps.broadcastDockerBuildLog;
  broadcastComplete = deps.broadcastDockerBuildComplete;
}

const monitorRoutes = new Hono<{ Variables: Variables }>();

// GET /api/health - 健康检查（无认证）
monitorRoutes.get('/health', async (c) => {
  const checks = {
    database: false,
    queue: false,
    uptime: 0,
  };

  let healthy = true;

  // 检查数据库连通性
  try {
    getRouterState('last_timestamp');
    checks.database = true;
  } catch (err) {
    healthy = false;
    logger.warn({ err }, '健康检查：数据库连接失败');
  }

  // 检查队列状态
  try {
    const deps = getWebDeps();
    if (deps && deps.queue) {
      checks.queue = true;
    } else {
      healthy = false;
    }
  } catch (err) {
    healthy = false;
    logger.warn({ err }, '健康检查：队列不可用');
  }

  // 进程运行时间
  checks.uptime = Math.floor(process.uptime());

  const status = healthy ? 'healthy' : 'unhealthy';
  const statusCode = healthy ? 200 : 503;

  return c.json({ status, checks }, statusCode);
});

async function checkDockerImageExists(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', CONTAINER_IMAGE], {
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// GET /api/status - 获取系统状态
monitorRoutes.get('/status', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const authUser = c.get('user') as AuthUser;
  const isAdmin = hasHostExecutionPermission(authUser);
  const queueStatus = deps.queue.getStatus();

  // 监控页面属于系统管理功能，admin 可见所有群组状态（不受工作区隔离约束）
  const filteredGroups = isAdmin
    ? queueStatus.groups
    : queueStatus.groups.filter((g) => {
        const group = getRegisteredGroup(g.jid);
        if (!group) return false;
        if (isHostExecutionGroup(group)) return false;
        return canAccessGroup({ id: authUser.id, role: authUser.role }, group);
      });

  const dockerImageExists = await checkDockerImageExists();

  // For non-admin users, derive aggregate metrics from their own filtered groups only
  // to prevent leaking global system load information across users
  let activeContainers: number;
  let queueLength: number;
  if (isAdmin) {
    activeContainers = queueStatus.activeContainerCount;
    queueLength = queueStatus.waitingCount;
  } else {
    activeContainers = filteredGroups.filter((g) => g.active).length;
    // Filter waiting groups by user ownership
    queueLength = queueStatus.waitingGroupJids.filter((jid) => {
      const group = getRegisteredGroup(jid);
      if (!group) return false;
      if (isHostExecutionGroup(group)) return false;
      return canAccessGroup({ id: authUser.id, role: authUser.role }, group);
    }).length;
  }

  return c.json({
    activeContainers,
    activeHostProcesses: isAdmin
      ? queueStatus.activeHostProcessCount
      : undefined,
    activeTotal: isAdmin ? queueStatus.activeCount : activeContainers,
    maxConcurrentContainers: getSystemSettings().maxConcurrentContainers,
    maxConcurrentHostProcesses: isAdmin
      ? getSystemSettings().maxConcurrentHostProcesses
      : undefined,
    queueLength,
    uptime: Math.floor(process.uptime()),
    groups: filteredGroups,
    dockerImageExists,
    dockerBuildInProgress: buildState.building,
    codexDiagnostics: isAdmin
      ? await getCodexDiagnostics(dockerImageExists)
      : undefined,
    dockerBuildLogs:
      isAdmin && buildState.building ? buildState.logs.slice(-50) : undefined,
    dockerBuildResult: isAdmin ? buildState.result : undefined,
  });
});

// POST /api/docker/build - 构建 Docker 镜像（仅 admin，异步启动 + WS 推送进度）
monitorRoutes.post(
  '/docker/build',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    if (buildState.building) {
      return c.json(
        {
          error: 'Docker image build already in progress',
          startedAt: buildState.startedAt,
          startedBy: buildState.startedBy,
        },
        409,
      );
    }

    const authUser = c.get('user') as AuthUser;
    const buildScript = path.resolve(process.cwd(), 'container', 'build.sh');

    buildState = {
      building: true,
      startedAt: Date.now(),
      startedBy: authUser.username,
      logs: [],
      result: null,
    };
    logger.info(
      { startedBy: authUser.username },
      'Docker image build requested via API',
    );

    // Spawn build process asynchronously
    const proc = spawn('bash', [buildScript], {
      cwd: path.resolve(process.cwd(), 'container'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 10-minute timeout
    const timeout = setTimeout(
      () => {
        proc.kill('SIGKILL');
        const errMsg = 'Docker build timed out after 10 minutes';
        logger.error(errMsg);
        buildState.building = false;
        buildState.result = { success: false, error: errMsg };
        broadcastLog?.(errMsg);
        broadcastComplete?.(false, errMsg);
      },
      10 * 60 * 1000,
    );

    const pushLine = (line: string) => {
      buildState.logs.push(line);
      // Keep last 200 lines in memory
      if (buildState.logs.length > 200) {
        buildState.logs = buildState.logs.slice(-200);
      }
      broadcastLog?.(line);
    };

    // Read stdout and stderr line by line
    if (proc.stdout) {
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', pushLine);
    }
    if (proc.stderr) {
      const rl = readline.createInterface({ input: proc.stderr });
      rl.on('line', pushLine);
    }

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const success = code === 0;
      const error = success
        ? undefined
        : `Build process exited with code ${code}`;
      if (success) {
        logger.info('Docker image build completed');
      } else {
        logger.error({ code }, 'Docker image build failed');
      }
      buildState.building = false;
      buildState.result = { success, error };
      broadcastComplete?.(success, error);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      const errorMsg = err.message;
      logger.error({ err }, 'Docker image build process error');
      buildState.building = false;
      buildState.result = { success: false, error: errorMsg };
      broadcastComplete?.(false, errorMsg);
    });

    // Return immediately with 202 Accepted
    return c.json(
      {
        accepted: true,
        message:
          'Docker image build started. Progress will be streamed via WebSocket.',
      },
      202,
    );
  },
);

export default monitorRoutes;

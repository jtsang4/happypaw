import { INTERNAL_MCP_BRIDGE_ID } from '../product.js';
import type { CodexAppServerClient } from '../codex-client.js';
import type { ContainerInput, ContainerOutput } from '../types.js';
import type {
  CodexMcpServerStatus,
  McpServerStatusListResult,
} from './shared.js';
import { emitCodexStatus, normalizeMcpServerStatus } from './stream-mappers.js';

const INTERNAL_MCP_BRIDGE_STATUS_NAME =
  process.env.HAPPYPAW_MCP_SERVER_ID?.trim() || INTERNAL_MCP_BRIDGE_ID;
const REQUIRED_MCP_BRIDGE_BASE_TOOLS = [
  'cancel_task',
  'get_context',
  'list_tasks',
  'memory_get',
  'memory_search',
  'pause_task',
  'resume_task',
  'schedule_task',
  'send_file',
  'send_image',
  'send_message',
];
const REQUIRED_MCP_BRIDGE_HOME_ONLY_TOOLS = ['memory_append'];
const MCP_SERVER_STATUS_PAGE_LIMIT = 100;
const MCP_SERVER_STATUS_PAGE_MAX = 20;

function isInternalMcpBridgeStatus(status: CodexMcpServerStatus): boolean {
  return status.name === INTERNAL_MCP_BRIDGE_STATUS_NAME;
}

async function listCodexMcpServerStatuses(
  client: CodexAppServerClient,
): Promise<CodexMcpServerStatus[]> {
  const statuses: CodexMcpServerStatus[] = [];
  let cursor: string | null | undefined = undefined;

  for (let page = 0; page < MCP_SERVER_STATUS_PAGE_MAX; page += 1) {
    const response: McpServerStatusListResult = await client.request(
      'mcpServerStatus/list',
      {
        ...(cursor ? { cursor } : {}),
        limit: MCP_SERVER_STATUS_PAGE_LIMIT,
      },
    );

    for (const entry of response.data) {
      const normalized = normalizeMcpServerStatus(entry);
      if (normalized) statuses.push(normalized);
    }

    cursor = response.nextCursor?.trim() ? response.nextCursor : null;
    if (!cursor) break;
  }

  return statuses;
}

export async function verifyInternalMcpBridgeHealth(options: {
  client: CodexAppServerClient;
  emit: (output: ContainerOutput) => void;
  containerInput: ContainerInput;
  sessionId: string | undefined;
  startupWarnings: string[];
}): Promise<void> {
  const { client, emit, containerInput, sessionId, startupWarnings } = options;

  const formatWarningSuffix = (): string =>
    startupWarnings.length > 0
      ? ` 附加诊断: ${startupWarnings.join(' | ')}`
      : '';

  let statuses: CodexMcpServerStatus[];
  try {
    statuses = await listCodexMcpServerStatuses(client);
  } catch (error) {
    const message =
      `HappyPaw MCP 桥接健康检查失败：无法读取 mcpServerStatus/list（${
        error instanceof Error ? error.message : String(error)
      }）。已阻止本次 Codex 对话继续，请检查 .codex/config.toml 中的 happypaw 桥接配置以及 codex-mcp-bridge.mjs 是否可执行。` +
      formatWarningSuffix();
    emitCodexStatus(emit, containerInput, sessionId, message);
    throw new Error(message);
  }

  const bridgeStatus = statuses.find(isInternalMcpBridgeStatus);
  if (!bridgeStatus) {
    const discovered =
      statuses.length > 0
        ? ` 已发现的 MCP 服务: ${statuses
            .map((status) => `${status.name}[${status.tools.length}]`)
            .join(', ')}。`
        : ' 当前没有任何可用的 MCP 服务状态。';
    const message =
      `HappyPaw MCP 桥接未成功注册或启动，已阻止本次 Codex 对话继续。请检查 .codex/config.toml 中的 happypaw 桥接配置、桥接进程启动日志以及 codex-mcp-bridge.mjs 路径。${discovered}` +
      formatWarningSuffix();
    emitCodexStatus(emit, containerInput, sessionId, message);
    throw new Error(message);
  }

  if (bridgeStatus.authStatus === 'notLoggedIn') {
    const message =
      `HappyPaw MCP 桥接鉴权未完成（authStatus=notLoggedIn），已阻止本次 Codex 对话继续。请检查桥接注册配置与 Codex MCP 登录状态。` +
      formatWarningSuffix();
    emitCodexStatus(emit, containerInput, sessionId, message);
    throw new Error(message);
  }

  const requiredTools = [
    ...REQUIRED_MCP_BRIDGE_BASE_TOOLS,
    ...(containerInput.isHome ? REQUIRED_MCP_BRIDGE_HOME_ONLY_TOOLS : []),
  ];
  const missingTools = requiredTools.filter(
    (toolName) => !bridgeStatus.tools.includes(toolName),
  );
  if (missingTools.length > 0) {
    const message =
      `HappyPaw MCP 桥接已启动但缺少必需工具：${missingTools.join(', ')}。已阻止本次 Codex 对话继续，请检查桥接脚本初始化流程与内置工具注册。` +
      formatWarningSuffix();
    emitCodexStatus(emit, containerInput, sessionId, message);
    throw new Error(message);
  }
}

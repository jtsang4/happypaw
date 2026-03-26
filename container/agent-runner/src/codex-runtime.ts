import fs from 'fs';
import path from 'path';

import type { ContainerInput, ContainerOutput } from './types.js';
import { CodexAppServerClient, type CodexJsonRpcNotification } from './codex-client.js';
import { getChannelFromJid } from './channel-prefixes.js';
import { summarizeToolInput } from './utils.js';

const OUTPUT_MARKER_TURN_ID_PREFIX = 'codex-turn-';
const IMAGE_MAX_DIMENSION = 8000;
const GLOBAL_CLAUDE_MD_MAX_CHARS = 8000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;
const LEGACY_MCP_SERVER_NAME = ['happy', 'claw'].join('');
const LEGACY_MCP_TOOL_PREFIX = ['mcp', LEGACY_MCP_SERVER_NAME].join('__');

type StreamResult = {
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  lastAssistantUuid?: string;
  newSessionId?: string;
  unrecoverableTranscriptError?: boolean;
  contextOverflow?: boolean;
  sessionResumeFailed?: boolean;
  followUpInput?: {
    text: string;
    images?: Array<{ data: string; mimeType?: string }>;
  };
};

type CodexTodo = {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

type ReasoningItemState = {
  surfacedSummaryIndexes: Set<number>;
  summaryTextByIndex: Map<number, string>;
  pendingSummaryIndexes: Set<number>;
};

const TURN_TERMINAL_IGNORED_METHODS = new Set([
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/plan/delta',
  'item/mcpToolCall/progress',
  'turn/plan/updated',
]);

interface RuntimeDeps {
  WORKSPACE_GLOBAL: string;
  WORKSPACE_GROUP: string;
  WORKSPACE_MEMORY: string;
  SECURITY_RULES: string;
  log: (message: string) => void;
  writeOutput: (output: ContainerOutput) => void;
  shouldInterrupt: () => boolean;
  shouldClose: () => boolean;
  shouldDrain: () => boolean;
  drainIpcInput: () => {
    messages: Array<{
      text: string;
      images?: Array<{ data: string; mimeType?: string }>;
    }>;
  };
  normalizeHomeFlags: (
    input: ContainerInput,
  ) => { isHome: boolean; isAdminHome: boolean };
  buildChannelGuidelines: (channel: string) => string;
  truncateWithHeadTail: (content: string, maxChars: number) => string;
  generateTurnId: () => string;
}

function resolveImageMimeType(
  img: { data: string; mimeType?: string },
  detectImageMimeTypeFromBase64Strict: (data: string) => string | undefined,
  log: (message: string) => void,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const declared =
    typeof img.mimeType === 'string' && img.mimeType.startsWith('image/')
      ? img.mimeType.toLowerCase()
      : undefined;
  const detected = detectImageMimeTypeFromBase64Strict(img.data);

  if (declared && detected && declared !== detected) {
    log(
      `Image MIME mismatch: declared=${declared}, detected=${detected}, using detected`,
    );
    return detected as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  }

  return (declared || detected || 'image/jpeg') as
    | 'image/jpeg'
    | 'image/png'
    | 'image/gif'
    | 'image/webp';
}

function getImageDimensions(base64Data: string): { width: number; height: number } | null {
  try {
    const headerB64 = base64Data.slice(0, 400);
    const buf = Buffer.from(headerB64, 'base64');

    if (
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      const fullHeader = Buffer.from(base64Data.slice(0, 40000), 'base64');
      for (let i = 2; i < fullHeader.length - 9; i++) {
        if (fullHeader[i] !== 0xff) continue;
        const marker = fullHeader[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            width: fullHeader.readUInt16BE(i + 7),
            height: fullHeader.readUInt16BE(i + 5),
          };
        }
        if (marker !== 0xd8 && marker !== 0xd9 && marker !== 0x00) {
          i += 1 + fullHeader.readUInt16BE(i + 2);
        }
      }
    }

    if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return {
        width: buf.readInt32LE(18),
        height: Math.abs(buf.readInt32LE(22)),
      };
    }

    if (
      buf.length >= 30 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46
    ) {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && buf.length >= 30) {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      if (fourCC === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      if (fourCC === 'VP8X' && buf.length >= 30) {
        return {
          width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
          height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function filterOversizedImages(
  images: Array<{ data: string; mimeType?: string }>,
  log: (message: string) => void,
): { valid: Array<{ data: string; mimeType?: string }>; rejected: string[] } {
  const valid: Array<{ data: string; mimeType?: string }> = [];
  const rejected: string[] = [];
  for (const img of images) {
    const dims = getImageDimensions(img.data);
    if (
      dims &&
      (dims.width > IMAGE_MAX_DIMENSION || dims.height > IMAGE_MAX_DIMENSION)
    ) {
      const reason = `图片尺寸 ${dims.width}×${dims.height} 超过 API 限制（最大 ${IMAGE_MAX_DIMENSION}px），已跳过`;
      log(reason);
      rejected.push(reason);
      continue;
    }
    valid.push(img);
  }
  return { valid, rejected };
}

function buildUserInput(
  prompt: string,
  images: Array<{ data: string; mimeType?: string }> | undefined,
  detectImageMimeTypeFromBase64Strict: (data: string) => string | undefined,
  log: (message: string) => void,
): {
  input: Array<Record<string, unknown>>;
  rejected: string[];
} {
  const filteredImages = images
    ? filterOversizedImages(images, log)
    : { valid: [], rejected: [] };

  return {
    input: [
      {
        type: 'text',
        text: prompt,
        text_elements: [],
      },
      ...filteredImages.valid.map((img) => ({
        type: 'image',
        url: `data:${resolveImageMimeType(
          img,
          detectImageMimeTypeFromBase64Strict,
          log,
        )};base64,${img.data}`,
      })),
    ],
    rejected: filteredImages.rejected,
  };
}

function combineQueuedMessages(
  messages: Array<{ text: string; images?: Array<{ data: string; mimeType?: string }> }>,
): { text: string; images?: Array<{ data: string; mimeType?: string }> } | undefined {
  if (messages.length === 0) return undefined;

  const text = messages.map((message) => message.text).join('\n');
  const images = messages.flatMap((message) => message.images ?? []);

  return {
    text,
    images: images.length > 0 ? images : undefined,
  };
}

function buildRuntimePromptContext(
  deps: RuntimeDeps,
  containerInput: ContainerInput,
  memoryRecall: string,
): { extraDirs: string[]; systemPromptAppend: string } {
  const { isHome } = deps.normalizeHomeFlags(containerInput);
  const globalClaudeMdPath = path.join(deps.WORKSPACE_GLOBAL, 'CLAUDE.md');

  let globalClaudeMd = '';
  if (isHome && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    globalClaudeMd = deps.truncateWithHeadTail(
      globalClaudeMd,
      GLOBAL_CLAUDE_MD_MAX_CHARS,
    );
  }

  const outputGuidelines = [
    '',
    '## 输出格式',
    '',
    '### 图片引用',
    '当你生成了图片文件并需要在回复中展示时，使用 Markdown 图片语法引用**相对路径**（相对于当前工作目录）：',
    '`![描述](filename.png)`',
    '',
    '**禁止使用绝对路径**（如 `/workspace/group/filename.png`）。Web 界面会自动将相对路径解析为正确的文件下载地址。',
    '',
    '### 技术图表',
    '需要输出技术图表（流程图、时序图、架构图、ER 图、类图、状态图、甘特图等）时，**使用 Mermaid 语法**，用 ```mermaid 代码块包裹。',
    'Web 界面会自动将 Mermaid 代码渲染为可视化图表。',
  ].join('\n');

  const webFetchGuidelines = [
    '',
    '## 网页访问策略',
    '',
    '访问外部网页时优先使用 WebFetch（速度快）。',
    '如果 WebFetch 失败（403、被拦截、内容为空或需要 JavaScript 渲染），',
    '且 agent-browser 可用，立即改用 agent-browser 通过真实浏览器访问。不要反复重试 WebFetch。',
  ].join('\n');

  let heartbeatContent = '';
  if (isHome) {
    const heartbeatPath = path.join(deps.WORKSPACE_GLOBAL, 'HEARTBEAT.md');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const raw = fs.readFileSync(heartbeatPath, 'utf-8');
        const truncated =
          raw.length > 2048 ? raw.slice(0, 2048) + '\n\n[...截断]' : raw;
        heartbeatContent = [
          '',
          '## 近期工作参考（仅供背景了解）',
          '',
          '> 以下是系统自动生成的近期工作摘要，仅供参考。',
          '> **不要主动继续这些工作**，除非用户明确要求「继续」或主动提到相关话题。',
          '> 请专注于用户当前的消息。',
          '',
          truncated,
        ].join('\n');
      } catch {
        /* skip */
      }
    }
  }

  const backgroundTaskGuidelines = [
    '',
    '## 后台任务',
    '',
    '当用户要求执行耗时较长的批量任务（如批量文件处理、大规模数据操作等），',
    '你应该使用 Task 工具并设置 `run_in_background: true`，让任务在后台运行。',
    '这样用户无需等待，可以继续与你交流其他事项。',
    '任务结束时你会自动收到通知，届时在对话中向用户汇报即可。',
    '告知用户：「已为您在后台启动该任务，完成后我会第一时间反馈。现在有其他问题也可以随时问我。」',
  ].join('\n');

  const interactionGuidelines = [
    '',
    '## 交互原则',
    '',
    '**始终专注于用户当前的实际消息。**',
    '',
    '- 你可能拥有多种 MCP 工具（如外卖点餐、优惠券查询等），这些是你的辅助能力，**不是用户发送的内容**。',
    '- **不要主动介绍、列举或描述你的可用工具**，除非用户明确询问「你能做什么」或「你有什么功能」。',
    '- 当用户需要某个功能时，直接使用对应工具完成任务即可，无需事先解释工具的存在。',
    '- 如果用户的消息很简短（如打招呼），简洁回应即可，不要用工具列表填充回复。',
  ].join('\n');

  const conversationAgentGuidelines = containerInput.agentId
    ? [
        '',
        '## 子会话行为规则（最高优先级，覆盖其他冲突指令）',
        '',
        '你正在一个**子会话**中运行，不是主会话。以下规则覆盖全局记忆中的"响应行为准则"：',
        '',
        '1. **不要用 `send_message` 发送"收到"之类的确认消息** — 你的正常文本输出就是回复，不需要额外发消息',
        '2. **每次回复只产生一条消息** — 把分析、结论、建议整合到一条回复中，不要拆成多条',
        '3. **只在以下情况使用 `send_message`**：',
        '   - 执行超过 2 分钟的长任务时，发送一次进度更新（不是确认收到）',
        '   - 用户明确要求你"先回复一下"时',
        '4. **你的正常文本输出会自动发送给用户**，不需要通过 `send_message` 转发',
        '5. **回复语言使用简体中文**，除非用户用其他语言提问',
      ].join('\n')
    : '';

  const channelGuidelines = deps.buildChannelGuidelines(
    getChannelFromJid(containerInput.chatJid),
  );

  const systemPromptAppend = [
    globalClaudeMd && `<user-profile>\n${globalClaudeMd}\n</user-profile>`,
    `<behavior>\n${interactionGuidelines}\n</behavior>`,
    `<security>\n${deps.SECURITY_RULES}\n</security>`,
    `<memory-system>\n${memoryRecall}\n</memory-system>`,
    heartbeatContent && `<recent-work>\n${heartbeatContent}\n</recent-work>`,
    `<output-format>\n${outputGuidelines}\n</output-format>`,
    `<web-access>\n${webFetchGuidelines}\n</web-access>`,
    `<background-tasks>\n${backgroundTaskGuidelines}\n</background-tasks>`,
    channelGuidelines && `<channel-format>\n${channelGuidelines}\n</channel-format>`,
    conversationAgentGuidelines &&
      `<agent-override>\n${conversationAgentGuidelines}\n</agent-override>`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    extraDirs: isHome
      ? [deps.WORKSPACE_GLOBAL, deps.WORKSPACE_MEMORY]
      : [deps.WORKSPACE_MEMORY],
    systemPromptAppend,
  };
}

function mapCodexToolName(server: string, tool: string): string {
  if (server === 'happypaw') {
    return `mcp__happypaw__${tool}`;
  }
  if (server === LEGACY_MCP_SERVER_NAME) {
    return `${LEGACY_MCP_TOOL_PREFIX}__${tool}`;
  }
  return `${server}:${tool}`;
}

function isNotificationForTurn(
  params: Record<string, unknown> | undefined,
  activeTurnId: string | undefined,
): boolean {
  return (
    !!activeTurnId &&
    typeof params?.turnId === 'string' &&
    params.turnId === activeTurnId
  );
}

function mapPlanStatus(
  status: unknown,
): 'pending' | 'in_progress' | 'completed' {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'inProgress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function buildPlanTodosFromUpdate(
  turnId: string,
  explanation: string | null | undefined,
  plan: unknown,
): CodexTodo[] {
  if (Array.isArray(plan) && plan.length > 0) {
    return plan
      .map((step, index) => {
        if (!step || typeof step !== 'object') return null;
        const record = step as { step?: unknown; status?: unknown };
        const content =
          typeof record.step === 'string' ? record.step.trim() : '';
        if (!content) return null;
        return {
          id: `codex-plan-${turnId}-${index}`,
          content,
          status: mapPlanStatus(record.status),
        } satisfies CodexTodo;
      })
      .filter((todo): todo is CodexTodo => !!todo);
  }

  if (typeof explanation === 'string' && explanation.trim()) {
    return [
      {
        id: `codex-plan-${turnId}-explanation`,
        content: explanation.trim(),
        status: 'in_progress',
      },
    ];
  }

  return [];
}

function normalizeTokenUsage(
  tokenUsage: Record<string, unknown>,
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
} {
  const preferred =
    tokenUsage.total && typeof tokenUsage.total === 'object'
      ? (tokenUsage.total as Record<string, unknown>)
      : tokenUsage.last && typeof tokenUsage.last === 'object'
        ? (tokenUsage.last as Record<string, unknown>)
        : {};

  return {
    inputTokens:
      typeof preferred.inputTokens === 'number' ? preferred.inputTokens : 0,
    outputTokens:
      typeof preferred.outputTokens === 'number' ? preferred.outputTokens : 0,
    cacheReadInputTokens:
      typeof preferred.cachedInputTokens === 'number'
        ? preferred.cachedInputTokens
        : 0,
  };
}

function emitCodexStreamEvent(
  emit: (output: ContainerOutput) => void,
  containerInput: ContainerInput,
  sessionId: string | undefined,
  output: Omit<ContainerOutput, 'turnId' | 'sessionId'>,
): void {
  const nextOutput: ContainerOutput = {
    ...output,
    turnId: containerInput.turnId,
    sessionId,
  };
  if (nextOutput.streamEvent) {
    nextOutput.streamEvent = {
      ...nextOutput.streamEvent,
      turnId: containerInput.turnId,
      sessionId,
    };
  }
  emit(nextOutput);
}

function emitCodexToolLifecycle(
  emit: (output: ContainerOutput) => void,
  containerInput: ContainerInput,
  sessionId: string | undefined,
  item: Record<string, unknown>,
): void {
  const itemId = typeof item.id === 'string' ? item.id : undefined;
  if (!itemId) return;

  switch (item.type) {
    case 'commandExecution': {
      const toolName = 'Bash';
      emitCodexStreamEvent(emit, containerInput, sessionId, {
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_use_start',
          toolName,
          toolUseId: itemId,
          toolInputSummary:
            typeof item.command === 'string'
              ? `command: ${item.command}`
              : undefined,
        },
      });
      break;
    }
    case 'mcpToolCall': {
      const toolName = mapCodexToolName(
        typeof item.server === 'string' ? item.server : 'mcp',
        typeof item.tool === 'string' ? item.tool : 'tool',
      );
      emitCodexStreamEvent(emit, containerInput, sessionId, {
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_use_start',
          toolName,
          toolUseId: itemId,
          toolInputSummary: summarizeToolInput(item.arguments),
        },
      });
      break;
    }
    case 'fileChange': {
      emitCodexStreamEvent(emit, containerInput, sessionId, {
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_use_start',
          toolName: 'ApplyPatch',
          toolUseId: itemId,
        },
      });
      break;
    }
    default:
      break;
  }
}

function emitCodexToolCompletion(
  emit: (output: ContainerOutput) => void,
  containerInput: ContainerInput,
  sessionId: string | undefined,
  item: Record<string, unknown>,
): void {
  const itemId = typeof item.id === 'string' ? item.id : undefined;
  if (!itemId) return;

  if (
    item.type === 'commandExecution' ||
    item.type === 'mcpToolCall' ||
    item.type === 'fileChange'
  ) {
    emitCodexStreamEvent(emit, containerInput, sessionId, {
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'tool_use_end',
        toolUseId: itemId,
      },
    });
  }
}

export async function runCodexRuntime(options: {
  prompt: string;
  sessionId: string | undefined;
  containerInput: ContainerInput;
  memoryRecall: string;
  emitOutput?: boolean;
  images?: Array<{ data: string; mimeType?: string }>;
  sourceKindOverride?: ContainerOutput['sourceKind'];
  deps: RuntimeDeps;
  detectImageMimeTypeFromBase64Strict: (data: string) => string | undefined;
}): Promise<StreamResult> {
  const {
    prompt,
    sessionId,
    containerInput,
    memoryRecall,
    emitOutput = true,
    images,
    sourceKindOverride,
    deps,
    detectImageMimeTypeFromBase64Strict,
  } = options;

  let currentSessionId = sessionId;
  const emit = (output: ContainerOutput): void => {
    if (emitOutput) {
      emitCodexStreamEvent(
        deps.writeOutput,
        containerInput,
        output.newSessionId ?? currentSessionId,
        output,
      );
    }
  };

  const { systemPromptAppend } = buildRuntimePromptContext(
    deps,
    containerInput,
    memoryRecall,
  );

  const initialInput = buildUserInput(
    prompt,
    images,
    detectImageMimeTypeFromBase64Strict,
    deps.log,
  );
  for (const reason of initialInput.rejected) {
    emit({
      status: 'success',
      result: `⚠️ ${reason}`,
    });
  }

  const userInput = initialInput.input;

  const client = new CodexAppServerClient({
    env: {
      ...process.env,
      CODEX_HOME: process.env.CODEX_HOME,
    },
    log: deps.log,
    onNotification: () => {},
  });

  let threadId = currentSessionId;
  let turnId: string | undefined;
  let finalText = '';
  let latestErrorMessage: string | undefined;
  let latestUsage:
    | {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
        durationMs: number;
        numTurns: number;
      }
    | undefined;
  let turnComplete:
    | {
        status: 'completed' | 'interrupted' | 'failed';
        turn?: Record<string, unknown>;
      }
    | undefined;
  let interruptedDuringQuery = false;
  let turnStartedAt = 0;
  let turnTerminal = false;
  let drainRequested = false;
  const planTodoOrder: string[] = [];
  const planTodos = new Map<string, CodexTodo>();
  const reasoningItems = new Map<string, ReasoningItemState>();
  const deferredFollowUps: Array<{
    text: string;
    images?: Array<{ data: string; mimeType?: string }>;
  }> = [];

  const emitThinkingDelta = (
    text: string,
    options?: { toolUseId?: string; isSynthetic?: boolean },
  ): void => {
    if (!text) return;
    emit({
      status: 'stream',
      result: null,
      newSessionId: currentSessionId,
      streamEvent: {
        eventType: 'thinking_delta',
        text,
        toolUseId: options?.toolUseId,
        isSynthetic: options?.isSynthetic,
      },
    });
  };

  const getReasoningItemState = (itemId: string): ReasoningItemState => {
    let state = reasoningItems.get(itemId);
    if (!state) {
      state = {
        surfacedSummaryIndexes: new Set<number>(),
        summaryTextByIndex: new Map<number, string>(),
        pendingSummaryIndexes: new Set<number>(),
      };
      reasoningItems.set(itemId, state);
    }
    return state;
  };

  const emitReasoningSummarySnapshot = (item: Record<string, unknown>): void => {
    if (item.type !== 'reasoning' || typeof item.id !== 'string') {
      return;
    }

    const summary = Array.isArray(item.summary) ? item.summary : [];
    const state = getReasoningItemState(item.id);
    const unsurfacedSummaryParts: string[] = [];

    summary.forEach((part, index) => {
      if (typeof part !== 'string') return;
      state.summaryTextByIndex.set(index, part);
      if (!part.trim()) return;

      if (
        state.pendingSummaryIndexes.has(index) ||
        !state.surfacedSummaryIndexes.has(index)
      ) {
        unsurfacedSummaryParts.push(part);
        state.surfacedSummaryIndexes.add(index);
        state.pendingSummaryIndexes.delete(index);
      }
    });

    if (unsurfacedSummaryParts.length > 0) {
      emitThinkingDelta(unsurfacedSummaryParts.join('\n'), {
        toolUseId: item.id,
        isSynthetic: true,
      });
    }
  };

  const handleReasoningSummaryPartAdded = (
    itemId: string,
    summaryIndex: number,
  ): void => {
    const state = getReasoningItemState(itemId);
    state.pendingSummaryIndexes.add(summaryIndex);

    const cachedText = state.summaryTextByIndex.get(summaryIndex);
    if (
      typeof cachedText === 'string' &&
      cachedText.trim() &&
      !state.surfacedSummaryIndexes.has(summaryIndex)
    ) {
      state.surfacedSummaryIndexes.add(summaryIndex);
      state.pendingSummaryIndexes.delete(summaryIndex);
      emitThinkingDelta(cachedText, {
        toolUseId: itemId,
        isSynthetic: true,
      });
    }
  };

  const noteReasoningSummaryTextDelta = (
    itemId: string,
    summaryIndex: number,
    delta: string,
  ): void => {
    const state = getReasoningItemState(itemId);
    const previous = state.summaryTextByIndex.get(summaryIndex) ?? '';
    state.summaryTextByIndex.set(summaryIndex, `${previous}${delta}`);
    state.surfacedSummaryIndexes.add(summaryIndex);
    state.pendingSummaryIndexes.delete(summaryIndex);
  };

  const emitPlanTodos = (): void => {
    const todos = planTodoOrder
      .map((id) => planTodos.get(id))
      .filter((todo): todo is CodexTodo => !!todo);
    if (todos.length === 0) return;
    emit({
      status: 'stream',
      result: null,
      newSessionId: currentSessionId,
      streamEvent: {
        eventType: 'todo_update',
        todos,
      },
    });
  };

  const replacePlanTodos = (todos: CodexTodo[]): void => {
    planTodoOrder.length = 0;
    planTodos.clear();
    for (const todo of todos) {
      planTodoOrder.push(todo.id);
      planTodos.set(todo.id, todo);
    }
    emitPlanTodos();
  };

  const upsertPlanTodo = (
    todoId: string,
    content: string,
    status: CodexTodo['status'],
  ): void => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (!planTodos.has(todoId)) {
      planTodoOrder.push(todoId);
    }
    planTodos.set(todoId, {
      id: todoId,
      content: trimmed,
      status,
    });
    emitPlanTodos();
  };

  try {
    const notificationHandler = (notification: CodexJsonRpcNotification): void => {
      const params =
        notification.params && typeof notification.params === 'object'
          ? (notification.params as Record<string, unknown>)
          : undefined;

      if (
        turnTerminal &&
        isNotificationForTurn(params, turnId) &&
        TURN_TERMINAL_IGNORED_METHODS.has(notification.method)
      ) {
        return;
      }

      switch (notification.method) {
        case 'thread/started':
          if (
            params?.thread &&
            typeof params.thread === 'object' &&
            typeof (params.thread as { id?: string }).id === 'string'
          ) {
            currentSessionId = (params.thread as { id: string }).id;
          }
          emit({
            status: 'stream',
            result: null,
            newSessionId: currentSessionId,
            streamEvent: {
              eventType: 'status',
              statusText: 'thread_started',
            },
          });
          break;
        case 'turn/started':
          if (isNotificationForTurn(params, turnId) && !turnStartedAt) {
            turnStartedAt = Date.now();
          }
          emit({
            status: 'stream',
            result: null,
            newSessionId: currentSessionId,
            streamEvent: {
              eventType: 'status',
              statusText: 'turn_started',
            },
          });
          break;
        case 'item/started':
          if (params?.item && typeof params.item === 'object') {
            const item = params.item as Record<string, unknown>;
            if (
              item.type === 'plan' &&
              typeof item.id === 'string' &&
              typeof item.text === 'string'
            ) {
              upsertPlanTodo(item.id, item.text, 'in_progress');
            }
            emitReasoningSummarySnapshot(item);
            emitCodexToolLifecycle(
              emit,
              containerInput,
              currentSessionId,
              item,
            );
          }
          break;
        case 'item/completed':
          if (params?.item && typeof params.item === 'object') {
            const item = params.item as Record<string, unknown>;
            if (
              item.type === 'plan' &&
              typeof item.id === 'string' &&
              typeof item.text === 'string'
            ) {
              upsertPlanTodo(item.id, item.text, 'completed');
            }
            emitReasoningSummarySnapshot(item);
            emitCodexToolCompletion(
              emit,
              containerInput,
              currentSessionId,
              item,
            );
          }
          break;
        case 'item/agentMessage/delta':
          if (
            typeof params?.turnId === 'string' &&
            params.turnId === turnId &&
            typeof params.delta === 'string'
          ) {
            finalText += params.delta;
            emit({
              status: 'stream',
              result: null,
              newSessionId: currentSessionId,
              streamEvent: {
                eventType: 'text_delta',
                text: params.delta,
              },
            });
          }
          break;
        case 'item/reasoning/textDelta':
          if (
            typeof params?.turnId === 'string' &&
            params.turnId === turnId &&
            typeof params.delta === 'string'
          ) {
            emitThinkingDelta(params.delta);
          }
          break;
        case 'item/reasoning/summaryTextDelta':
          if (
            typeof params?.turnId === 'string' &&
            params.turnId === turnId &&
            typeof params.delta === 'string'
          ) {
            if (
              typeof params.itemId === 'string' &&
              typeof params.summaryIndex === 'number'
            ) {
              noteReasoningSummaryTextDelta(
                params.itemId,
                params.summaryIndex,
                params.delta,
              );
            }
            emitThinkingDelta(params.delta);
          }
          break;
        case 'item/reasoning/summaryPartAdded':
          if (
            typeof params?.turnId === 'string' &&
            params.turnId === turnId &&
            typeof params.itemId === 'string' &&
            typeof params.summaryIndex === 'number'
          ) {
            handleReasoningSummaryPartAdded(params.itemId, params.summaryIndex);
          }
          break;
        case 'turn/plan/updated':
          if (isNotificationForTurn(params, turnId)) {
            const todos = buildPlanTodosFromUpdate(
              params?.turnId as string,
              typeof params?.explanation === 'string'
                ? params.explanation
                : null,
              params?.plan,
            );
            if (todos.length > 0) {
              replacePlanTodos(todos);
            }
          }
          break;
        case 'item/commandExecution/outputDelta':
        case 'item/fileChange/outputDelta':
        case 'item/plan/delta':
          if (
            typeof params?.turnId === 'string' &&
            params.turnId === turnId &&
            typeof params.delta === 'string'
          ) {
            if (
              notification.method === 'item/plan/delta' &&
              typeof params.itemId === 'string'
            ) {
              const previous = planTodos.get(params.itemId)?.content || '';
              upsertPlanTodo(
                params.itemId,
                `${previous}${params.delta}`,
                'in_progress',
              );
            } else {
              emit({
                status: 'stream',
                result: null,
                newSessionId: currentSessionId,
                streamEvent: {
                  eventType: 'tool_progress',
                  toolUseId:
                    typeof params.itemId === 'string'
                      ? params.itemId
                      : undefined,
                  text: params.delta,
                },
              });
            }
          }
          break;
        case 'item/mcpToolCall/progress':
          if (
            typeof params?.turnId === 'string' &&
            params.turnId === turnId
          ) {
            emit({
              status: 'stream',
              result: null,
              newSessionId: currentSessionId,
              streamEvent: {
                eventType: 'tool_progress',
                toolUseId:
                  typeof params.itemId === 'string' ? params.itemId : undefined,
                text:
                  typeof params.message === 'string' ? params.message : undefined,
              },
            });
          }
          break;
        case 'thread/tokenUsage/updated':
          if (
            typeof params?.turnId === 'string' &&
            params.turnId === turnId &&
            params.tokenUsage &&
            typeof params.tokenUsage === 'object'
          ) {
            const usage = normalizeTokenUsage(
              params.tokenUsage as Record<string, unknown>,
            );
            latestUsage = {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadInputTokens: usage.cacheReadInputTokens,
              cacheCreationInputTokens: 0,
              costUSD: 0,
              durationMs: latestUsage?.durationMs ?? 0,
              numTurns: 1,
            };
          }
          break;
        case 'turn/completed':
          if (
            typeof params?.turn === 'object' &&
            params.turn &&
            typeof (params.turn as { id?: string }).id === 'string' &&
            (params.turn as { id: string }).id === turnId
          ) {
            const turn = params.turn as Record<string, unknown>;
            const status =
              turn.status === 'completed' ||
              turn.status === 'interrupted' ||
              turn.status === 'failed'
                ? (turn.status as 'completed' | 'interrupted' | 'failed')
                : 'failed';
            if (
              !finalText &&
              Array.isArray(turn.items)
            ) {
              finalText = (turn.items as Array<Record<string, unknown>>)
                .filter((item) => item.type === 'agentMessage')
                .map((item) =>
                  typeof item.text === 'string' ? item.text : '',
                )
                .join('\n');
            }
            if (latestUsage) {
              latestUsage.durationMs =
                turnStartedAt > 0 ? Math.max(Date.now() - turnStartedAt, 0) : 0;
            }
            turnTerminal = true;
            turnComplete = { status, turn };
          }
          break;
        case 'error':
          if (typeof params?.message === 'string') {
            latestErrorMessage = params.message;
          }
          break;
        default:
          break;
      }
    };
    client.setNotificationHandler(notificationHandler);

    await client.initialize();

    if (deps.shouldInterrupt()) {
      return {
        closedDuringQuery: false,
        interruptedDuringQuery: true,
        newSessionId: threadId,
      };
    }

    try {
      if (threadId) {
        const resumeResult = (await client.request('thread/resume', {
          threadId,
          cwd: deps.WORKSPACE_GROUP,
          approvalPolicy: 'never',
          persistExtendedHistory: false,
          baseInstructions: systemPromptAppend,
        })) as { thread?: { id?: string } };
        threadId = resumeResult.thread?.id || threadId;
      } else {
        const startResult = (await client.request('thread/start', {
          cwd: deps.WORKSPACE_GROUP,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          baseInstructions: systemPromptAppend,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        })) as { thread?: { id?: string } };
        threadId = startResult.thread?.id;
      }
      currentSessionId = threadId;
    } catch (error) {
      if (threadId) {
        deps.log(
          `thread/resume failed, falling back to fresh thread: ${String(error)}`,
        );
        const startResult = (await client.request('thread/start', {
          cwd: deps.WORKSPACE_GROUP,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          baseInstructions: systemPromptAppend,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        })) as { thread?: { id?: string } };
        threadId = startResult.thread?.id;
        currentSessionId = threadId;
      } else {
        throw error;
      }
    }

    const turnResult = (await client.request('turn/start', {
      threadId,
      input: userInput,
    })) as { turn?: { id?: string } };
    turnId = turnResult.turn?.id;
    turnStartedAt = Date.now();
    turnTerminal = false;
    planTodoOrder.length = 0;
    planTodos.clear();

    emit({
      status: 'stream',
      result: null,
      newSessionId: currentSessionId,
      streamEvent: {
        eventType: 'init',
        statusText: 'codex_initialized',
      },
    });

    const monitorResult = await waitForTurnCompletion({
      shouldClose: deps.shouldClose,
      shouldInterrupt: deps.shouldInterrupt,
      shouldDrain: deps.shouldDrain,
      drainIpcInput: emitOutput ? deps.drainIpcInput : undefined,
      isTurnComplete: () => !!turnComplete,
      log: deps.log,
      onInterrupt: async () => {
        interruptedDuringQuery = true;
        if (threadId && turnId) {
          await client.request('turn/interrupt', { threadId, turnId });
        }
      },
      onSteer: async (message) => {
        if (!threadId || !turnId) {
          deferredFollowUps.push(message);
          return;
        }
        const steerInput = buildUserInput(
          message.text,
          message.images,
          detectImageMimeTypeFromBase64Strict,
          deps.log,
        );
        for (const reason of steerInput.rejected) {
          emit({
            status: 'success',
            result: `⚠️ ${reason}`,
          });
        }
        await client.request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          input: steerInput.input,
        });
      },
    });

    drainRequested = monitorResult.drainRequested || deps.shouldDrain();
    if (monitorResult.deferredFollowUp) {
      deferredFollowUps.push(monitorResult.deferredFollowUp);
    }

    if (monitorResult.state === 'closed') {
      return {
        closedDuringQuery: true,
        interruptedDuringQuery: false,
        newSessionId: currentSessionId,
        followUpInput: combineQueuedMessages(deferredFollowUps),
      };
    }
    if (monitorResult.state === 'interrupted') {
      return {
        closedDuringQuery: false,
        interruptedDuringQuery: true,
        newSessionId: currentSessionId,
        followUpInput: combineQueuedMessages(deferredFollowUps),
      };
    }
    if (!turnComplete) {
      throw new Error('Codex turn did not complete');
    }
    if (turnComplete.status === 'interrupted') {
      return {
        closedDuringQuery: false,
        interruptedDuringQuery: true,
        newSessionId: currentSessionId,
        followUpInput: combineQueuedMessages(deferredFollowUps),
      };
    }
    if (turnComplete.status === 'failed') {
      const message =
        latestErrorMessage ||
        ((turnComplete.turn?.error as { message?: string } | undefined)
          ?.message) ||
        'Codex turn failed unexpectedly';
      throw new Error(message);
    }

    const normalizedFinalText = finalText.trim() || null;
    emit({
      status: 'success',
      result: normalizedFinalText,
      newSessionId: currentSessionId,
      sourceKind: sourceKindOverride ?? 'sdk_final',
      finalizationReason: 'completed',
    });

    if (latestUsage) {
      emit({
        status: 'stream',
        result: null,
        newSessionId: currentSessionId,
        streamEvent: {
          eventType: 'usage',
          usage: latestUsage,
        },
      });
    }

    return {
      closedDuringQuery: drainRequested,
      interruptedDuringQuery,
      newSessionId: currentSessionId,
      lastAssistantUuid: turnId
        ? `${OUTPUT_MARKER_TURN_ID_PREFIX}${turnId}`
        : undefined,
      followUpInput: combineQueuedMessages(deferredFollowUps),
    };
  } finally {
    await client.close();
  }
}

async function waitForTurnCompletion(
  options: {
    shouldClose: () => boolean;
    shouldInterrupt: () => boolean;
    shouldDrain: () => boolean;
    drainIpcInput?: () => {
      messages: Array<{
        text: string;
        images?: Array<{ data: string; mimeType?: string }>;
      }>;
    };
    isTurnComplete: () => boolean;
    onInterrupt: (reason: 'closed' | 'interrupted') => Promise<void>;
    onSteer?: (message: {
      text: string;
      images?: Array<{ data: string; mimeType?: string }>;
    }) => Promise<void>;
    log?: (message: string) => void;
  },
): Promise<{
  state: 'completed' | 'closed' | 'interrupted';
  drainRequested: boolean;
  deferredFollowUp?: {
    text: string;
    images?: Array<{ data: string; mimeType?: string }>;
  };
}> {
  let closeRequested = false;
  let interruptRequested = false;
  let interruptSentAt = 0;
  let drainRequested = false;
  const deferredMessages: Array<{
    text: string;
    images?: Array<{ data: string; mimeType?: string }>;
  }> = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (options.isTurnComplete()) {
      return {
        state: closeRequested
          ? 'closed'
          : interruptRequested
            ? 'interrupted'
            : 'completed',
        drainRequested,
        deferredFollowUp: combineQueuedMessages(deferredMessages),
      };
    }
    if (!closeRequested && options.shouldClose()) {
      closeRequested = true;
      interruptSentAt = Date.now();
      await options.onInterrupt('closed');
    }
    if (!interruptRequested && options.shouldInterrupt()) {
      interruptRequested = true;
      interruptSentAt = Date.now();
      await options.onInterrupt('interrupted');
    }
    if (!drainRequested && options.shouldDrain()) {
      drainRequested = true;
    }
    if (
      !closeRequested &&
      !interruptRequested &&
      !drainRequested &&
      options.drainIpcInput &&
      options.onSteer
    ) {
      const followUp = combineQueuedMessages(options.drainIpcInput().messages);
      if (followUp) {
        try {
          await options.onSteer(followUp);
        } catch (error) {
          options.log?.(
            `turn/steer failed, deferring message to next turn: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          deferredMessages.push(followUp);
        }
      }
    }
    if (
      interruptSentAt > 0 &&
      Date.now() - interruptSentAt >= INTERRUPT_SETTLE_TIMEOUT_MS
    ) {
      return {
        state: closeRequested ? 'closed' : 'interrupted',
        drainRequested,
        deferredFollowUp: combineQueuedMessages(deferredMessages),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * HappyPaw Agent Runner (Codex-only)
 *
 * Input protocol:
 *   - stdin: full ContainerInput JSON
 *   - IPC: follow-up messages written to /workspace/ipc/input/*.json
 *   - sentinels: _close / _drain / _interrupt
 *
 * Stdout protocol:
 *   - marker-delimited ContainerOutput JSON payloads
 */

import fs from 'fs';
import path from 'path';

import { runCodexRuntime } from './codex-runtime.js';
import { detectImageMimeTypeFromBase64Strict } from './shared/media/image-detector.js';
import type { ContainerInput, ContainerOutput } from './types.js';

export type { StreamEventType, StreamEvent } from './types.js';

const WORKSPACE_GROUP =
  process.env.HAPPYPAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL =
  process.env.HAPPYPAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY =
  process.env.HAPPYPAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC =
  process.env.HAPPYPAW_WORKSPACE_IPC || '/workspace/ipc';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_INPUT_DRAIN_SENTINEL = path.join(IPC_INPUT_DIR, '_drain');
const IPC_INPUT_INTERRUPT_SENTINEL = path.join(IPC_INPUT_DIR, '_interrupt');
const IPC_FALLBACK_POLL_MS = 5000;
const SECURITY_RULES_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'prompts',
  'security-rules.md',
);
const SECURITY_RULES = fs.readFileSync(SECURITY_RULES_PATH, 'utf-8');

const OUTPUT_START_MARKER = '---HAPPYPAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYPAW_OUTPUT_END---';

let latestSessionId: string | undefined;
let persistentCodexClient:
  | import('./codex-client.js').CodexAppServerClient
  | undefined;

interface IpcDrainResult {
  messages: Array<{
    text: string;
    images?: Array<{ data: string; mimeType?: string }>;
    sessionId?: string;
    chatJid?: string;
    replyRouteJid?: string;
  }>;
}

interface QueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  contextOverflow?: boolean;
  unrecoverableTranscriptError?: boolean;
  interruptedDuringQuery: boolean;
  sessionResumeFailed?: boolean;
  followUpInput?: {
    text: string;
    images?: Array<{ data: string; mimeType?: string }>;
    sessionId?: string;
    chatJid?: string;
    replyRouteJid?: string;
  };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function generateTurnId(): string {
  return `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeHomeFlags(
  input: ContainerInput,
): { isHome: boolean; isAdminHome: boolean } {
  return {
    isHome: !!input.isHome,
    isAdminHome: !!input.isAdminHome,
  };
}

function truncateWithHeadTail(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headSize = Math.floor(maxChars * 0.75);
  const tailSize = Math.max(0, maxChars - headSize - 30);
  return (
    content.slice(0, headSize) +
    '\n\n[...内容过长，已截断...]\n\n' +
    content.slice(-tailSize)
  );
}

function buildChannelGuidelines(channel: string): string {
  switch (channel) {
    case 'feishu':
      return [
        '## 飞书消息格式',
        '',
        '当前消息来自飞书。飞书卡片支持的 Markdown：**加粗**、_斜体_、`行内代码`、代码块、标题、列表、链接。',
        '用户同时可以在 Web 端查看你的回复，Web 端支持完整 Markdown + Mermaid 图表渲染，因此**不要因为来源是飞书就限制输出格式**。',
        '可使用 `send_image` 和 `send_file` 工具直接发送文件到飞书。',
      ].join('\n');
    case 'telegram':
      return [
        '## Telegram 消息格式',
        '',
        '当前消息来自 Telegram。Markdown 自动转换为 Telegram HTML，长消息自动分片（3800 字符）。',
        '用户同时可以在 Web 端查看你的回复，Web 端支持完整 Markdown + Mermaid 图表渲染，因此**不要因为来源是 Telegram 就限制输出格式**。',
        '可使用 `send_image` 和 `send_file` 工具直接发送文件到 Telegram。',
      ].join('\n');
    case 'qq':
      return [
        '## QQ 消息格式',
        '',
        '当前消息来自 QQ。Markdown 自动转换为纯文本，长消息自动分片（5000 字符）。',
        '用户同时可以在 Web 端查看你的回复，Web 端支持完整 Markdown + Mermaid 图表渲染，因此**不要因为来源是 QQ 就限制输出格式**。',
      ].join('\n');
    default:
      return '';
  }
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function shouldDrain(): boolean {
  if (fs.existsSync(IPC_INPUT_DRAIN_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_DRAIN_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function shouldInterrupt(): boolean {
  if (fs.existsSync(IPC_INPUT_INTERRUPT_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function cleanupStartupInterruptSentinel(): void {
  try {
    fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
  } catch {
    /* ignore */
  }
}

function drainIpcInput(): IpcDrainResult {
  const result: IpcDrainResult = { messages: [] };
  try {
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          type?: string;
          text?: string;
          images?: Array<{ data: string; mimeType?: string }>;
          sessionId?: string;
          chatJid?: string;
          replyRouteJid?: string;
        };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          result.messages.push({
            text: data.text,
            images: data.images,
            sessionId:
              typeof data.sessionId === 'string' && data.sessionId.trim()
                ? data.sessionId
                : undefined,
            chatJid:
              typeof data.chatJid === 'string' && data.chatJid.trim()
                ? data.chatJid
                : undefined,
            replyRouteJid:
              typeof data.replyRouteJid === 'string' &&
              data.replyRouteJid.trim()
                ? data.replyRouteJid
                : undefined,
          });
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

function createIpcWatcher(onFileDetected: () => void): { close: () => void } {
  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const debouncedDetect = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onFileDetected();
    }, 50);
  };

  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  } catch {
    /* ignore */
  }

  try {
    watcher = fs.watch(IPC_INPUT_DIR, () => {
      debouncedDetect();
    });
    watcher.on('error', (err) => {
      log(
        `IPC watcher error: ${err.message}, degrading to ${IPC_FALLBACK_POLL_MS}ms fallback polling`,
      );
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    log(
      `Failed to create IPC watcher: ${
        err instanceof Error ? err.message : String(err)
      }, using fallback polling`,
    );
  }

  fallbackTimer = setInterval(() => {
    if (!closed) onFileDetected();
  }, IPC_FALLBACK_POLL_MS);
  fallbackTimer.unref();

  return {
    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    },
  };
}

function waitForIpcMessage(): Promise<{
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  sessionId?: string;
  chatJid?: string;
  replyRouteJid?: string;
} | null> {
  return new Promise((resolve) => {
    let resolved = false;

    const tryDrain = () => {
      if (resolved) return;

      if (shouldClose() || shouldDrain()) {
        resolved = true;
        watcher.close();
        resolve(null);
        return;
      }

      if (shouldInterrupt()) {
        log('Interrupt sentinel received while idle, ignoring');
      }

      const { messages } = drainIpcInput();
      if (messages.length === 0) return;

      const [firstMessage, ...remainingMessages] = messages;
      const text = [firstMessage, ...remainingMessages]
        .map((message) => message.text)
        .join('\n');
      const images = messages.flatMap((message) => message.images || []);
      const latestMessage = messages[messages.length - 1];
      resolved = true;
      watcher.close();
      resolve({
        text,
        images: images.length > 0 ? images : undefined,
        sessionId: latestMessage?.sessionId,
        chatJid: latestMessage?.chatJid,
        replyRouteJid: latestMessage?.replyRouteJid,
      });
    };

    const watcher = createIpcWatcher(tryDrain);
    tryDrain();
  });
}

function buildMemoryRecallPrompt(isHome: boolean, isAdminHome: boolean): string {
  if (isHome) {
    return [
      '',
      '## 记忆系统',
      '',
      '你拥有跨会话的持久记忆能力，请积极使用。',
      '',
      '### 回忆',
      '在回答关于过去的工作、决策、日期、偏好或待办事项之前：',
      '先用 `memory_search` 搜索，再用 `memory_get` 获取完整上下文。',
      '',
      '### 存储——两层记忆架构',
      '',
      '获知重要信息后**必须立即保存**，不要等到上下文压缩。',
      '根据信息的**时效性**选择存储位置：',
      '',
      '#### 全局记忆（永久）→ 直接编辑 `/workspace/global/AGENTS.md`',
      '',
      '**优先使用全局记忆。** 适用于所有**跨会话仍然有用**的信息：',
      '- 用户身份：姓名、生日、联系方式、地址、工作单位',
      '- 长期偏好：沟通风格、称呼方式、喜好厌恶、技术栈偏好',
      '- 身份配置：你的名字、角色设定、行为准则',
      '- 常用项目与上下文：反复提到的仓库、服务、架构信息',
      '- 用户明确要求「记住」的任何内容',
      '',
      '使用 `Read` 工具读取当前内容，再用 `Edit` 工具**原地更新对应字段**。',
      '文件中标记「待记录」的字段发现信息后**必须立即填写**。',
      '不要追加重复信息，保持文件简洁有序。',
      '',
      '#### 日期记忆（时效性）→ 调用 `memory_append`',
      '',
      '适用于**过一段时间会过时**的信息：',
      '- 项目进展：今天做了什么、决定了什么、遇到了什么问题',
      '- 临时技术决策：选型理由、架构方案、变更记录',
      '- 待办与承诺：约定事项、截止日期、后续跟进',
      '- 会议/讨论要点：关键结论、行动项',
      '',
      '`memory_append` 自动保存到独立的记忆目录（不在工作区内）。',
      '',
      '#### 判断标准',
      '> **默认优先全局记忆。** 问自己：这条信息下次对话还可能用到吗？',
      '> - 是 / 可能 → **全局记忆**（编辑 `/workspace/global/AGENTS.md`）',
      '> - 明确只跟今天有关 → 日期记忆（`memory_append`）',
      '> - 用户说「记住这个」→ **一定写全局记忆**',
      '',
      '系统也会在上下文压缩前提示你保存记忆。',
    ].join('\n');
  }

  return [
    '',
    '## 记忆',
    '',
    '### 查询主工作区记忆',
    '可使用 `memory_search` 和 `memory_get` 工具搜索主工作区的记忆（全局记忆和日期记忆）。',
    '需要回忆过去的决策、偏好或项目上下文时使用这些工具。',
    '',
    '### 本地记忆',
    '重要信息直接记录在当前工作区的 AGENTS.md 或其他文件中。',
    '当前会话上下文由 Codex 线程持久化，重要长期信息仍应写入记忆文件。',
    '',
    '全局记忆（`/workspace/global/AGENTS.md`）为只读参考。',
  ].join('\n');
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  memoryRecall: string,
  images?: Array<{ data: string; mimeType?: string }>,
  sourceKindOverride?: ContainerOutput['sourceKind'],
): Promise<QueryResult> {
  return runCodexRuntime({
    prompt,
    sessionId,
    containerInput,
    memoryRecall,
    images,
    sourceKindOverride,
    detectImageMimeTypeFromBase64Strict: (data) =>
      detectImageMimeTypeFromBase64Strict(data) ?? undefined,
    deps: {
      WORKSPACE_GLOBAL,
      WORKSPACE_GROUP,
      WORKSPACE_MEMORY,
      SECURITY_RULES,
      log,
      writeOutput,
      shouldInterrupt,
      shouldClose,
      shouldDrain,
      drainIpcInput,
      normalizeHomeFlags,
      buildChannelGuidelines,
      truncateWithHeadTail,
      generateTurnId,
      getPersistentClient: () => persistentCodexClient,
      setPersistentClient: (client) => {
        persistentCodexClient = client;
      },
    },
  });
}

function forceExitWithSafetyNet(code: number): never {
  log(`Exiting with code ${code}, SIGKILL safety net in 5s`);
  persistentCodexClient?.terminate();
  persistentCodexClient = undefined;
  setTimeout(() => {
    console.error(
      '[agent-runner] process.exit() did not terminate, forcing SIGKILL',
    );
    process.kill(process.pid, 'SIGKILL');
  }, 5000);
  process.exit(code);
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  latestSessionId = sessionId;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
  const memoryRecallPrompt = buildMemoryRecallPrompt(isHome, isAdminHome);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  cleanupStartupInterruptSentinel();

  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  if (containerInput.isScheduledTask) {
    prompt = `[定时任务 - 以下内容由系统自动发送，并非来自用户或群组的直接消息。]\n\n${prompt}`;
  }

  const pendingDrain = drainIpcInput();
  if (pendingDrain.messages.length > 0) {
    log(
      `Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`,
    );
    prompt += '\n' + pendingDrain.messages.map((message) => message.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap(
      (message) => message.images || [],
    );
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
    const latestPendingMessage =
      pendingDrain.messages[pendingDrain.messages.length - 1];
    if (latestPendingMessage?.sessionId) {
      sessionId = latestPendingMessage.sessionId;
      latestSessionId = latestPendingMessage.sessionId;
    }
    if (latestPendingMessage?.chatJid) {
      containerInput.chatJid = latestPendingMessage.chatJid;
    }
    if (latestPendingMessage?.replyRouteJid) {
      containerInput.replyRouteJid = latestPendingMessage.replyRouteJid;
    }
  }

  try {
    while (true) {
      try {
        fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
      } catch {
        /* ignore */
      }

      log(`Starting Codex query (session: ${sessionId || 'new'})...`);
      const queryResult = await runQuery(
        prompt,
        sessionId,
        containerInput,
        memoryRecallPrompt,
        promptImages,
      );

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
        latestSessionId = sessionId;
      }

      if (queryResult.sessionResumeFailed) {
        log(
          `Session resume failed, retrying with fresh session (old: ${sessionId})`,
        );
        sessionId = undefined;
        latestSessionId = undefined;
        continue;
      }

      if (queryResult.unrecoverableTranscriptError) {
        const errorMsg =
          '会话历史中包含无法处理的数据（如超大图片或图片 MIME 错配），会话需要重置。';
        writeOutput({
          status: 'error',
          result: null,
          error: `unrecoverable_transcript: ${errorMsg}`,
          newSessionId: sessionId,
        });
        process.exit(1);
      }

      if (queryResult.contextOverflow) {
        const errorMsg =
          '上下文溢出错误：当前 Codex 会话无法继续，请联系管理员检查记忆与上下文大小。';
        writeOutput({
          status: 'error',
          result: null,
          error: `context_overflow: ${errorMsg}`,
          newSessionId: sessionId,
        });
        process.exit(1);
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        writeOutput({ status: 'closed', result: null });
        break;
      }

      if (queryResult.interruptedDuringQuery) {
        log('Query interrupted by user, waiting for next message');
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'status', statusText: 'interrupted' },
          newSessionId: sessionId,
        });

        if (queryResult.followUpInput) {
          log(
            `Re-entering immediately with deferred follow-up input after interrupt (${queryResult.followUpInput.text.length} chars, ${queryResult.followUpInput.images?.length || 0} images)`,
          );
          prompt = queryResult.followUpInput.text;
          promptImages = queryResult.followUpInput.images;
          if (queryResult.followUpInput.sessionId) {
            sessionId = queryResult.followUpInput.sessionId;
            latestSessionId = queryResult.followUpInput.sessionId;
          }
          if (queryResult.followUpInput.chatJid) {
            containerInput.chatJid = queryResult.followUpInput.chatJid;
          }
          if (queryResult.followUpInput.replyRouteJid) {
            containerInput.replyRouteJid =
              queryResult.followUpInput.replyRouteJid;
          }
          containerInput.turnId = generateTurnId();
          continue;
        }

        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received after interrupt, exiting');
          writeOutput({
            status: 'success',
            result: null,
            newSessionId: sessionId,
          });
          break;
        }

        prompt = nextMessage.text;
        promptImages = nextMessage.images;
        if (nextMessage.sessionId) {
          sessionId = nextMessage.sessionId;
          latestSessionId = nextMessage.sessionId;
        }
        if (nextMessage.chatJid) {
          containerInput.chatJid = nextMessage.chatJid;
        }
        if (nextMessage.replyRouteJid) {
          containerInput.replyRouteJid = nextMessage.replyRouteJid;
        }
        containerInput.turnId = generateTurnId();
        continue;
      }

      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      if (queryResult.followUpInput) {
        log(
          `Continuing with deferred follow-up input (${queryResult.followUpInput.text.length} chars, ${queryResult.followUpInput.images?.length || 0} images)`,
        );
        prompt = queryResult.followUpInput.text;
        promptImages = queryResult.followUpInput.images;
        if (queryResult.followUpInput.sessionId) {
          sessionId = queryResult.followUpInput.sessionId;
          latestSessionId = queryResult.followUpInput.sessionId;
        }
        if (queryResult.followUpInput.chatJid) {
          containerInput.chatJid = queryResult.followUpInput.chatJid;
        }
        if (queryResult.followUpInput.replyRouteJid) {
          containerInput.replyRouteJid = queryResult.followUpInput.replyRouteJid;
        }
        containerInput.turnId = generateTurnId();
        continue;
      }

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(
        `Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new query`,
      );
      prompt = nextMessage.text;
      promptImages = nextMessage.images;
      if (nextMessage.sessionId) {
        sessionId = nextMessage.sessionId;
        latestSessionId = nextMessage.sessionId;
      }
      if (nextMessage.chatJid) {
        containerInput.chatJid = nextMessage.chatJid;
      }
      if (nextMessage.replyRouteJid) {
        containerInput.replyRouteJid = nextMessage.replyRouteJid;
      }
      containerInput.turnId = generateTurnId();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`Agent error stack:\n${err.stack}`);
    }
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    forceExitWithSafetyNet(1);
  }

  forceExitWithSafetyNet(0);
}

process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting gracefully');
  persistentCodexClient?.terminate();
  persistentCodexClient = undefined;
  if (latestSessionId) {
    try {
      writeOutput({ status: 'success', result: null, newSessionId: latestSessionId });
    } catch {
      /* stdout may be closed */
    }
  }
  forceExitWithSafetyNet(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting gracefully');
  persistentCodexClient?.terminate();
  persistentCodexClient = undefined;
  forceExitWithSafetyNet(0);
});

(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on(
  'error',
  (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  },
);
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on(
  'error',
  (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  },
);

process.on('uncaughtException', (err: unknown) => {
  const errno = err as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  console.error(
    '[agent-runner] uncaughtException:',
    err instanceof Error ? err.stack || err.message : String(err),
  );
  forceExitWithSafetyNet(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const errno = reason as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  console.error(
    '[agent-runner] unhandledRejection:',
    reason instanceof Error ? reason.stack || reason.message : String(reason),
  );
  forceExitWithSafetyNet(1);
});

main();

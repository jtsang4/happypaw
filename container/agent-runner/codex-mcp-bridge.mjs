#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

const lines = [];

const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const MEMORY_SUBDIRS = new Set(['memory', 'conversations']);
const MEMORY_SKIP_DIRS = new Set(['logs', '.codex', 'node_modules', '.git']);
const MAX_MEMORY_FILE_SIZE = 512 * 1024;
const MAX_MEMORY_APPEND_SIZE = 16 * 1024;
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUPPORTED_OUTBOUND_IMAGE_CHANNELS = new Set(['feishu', 'telegram']);
const SUPPORTED_OUTBOUND_FILE_CHANNELS = new Set(['feishu', 'telegram']);

const ctx = {
  chatJid: process.env.HAPPYPAW_CHAT_JID || '',
  groupFolder: process.env.HAPPYPAW_GROUP_FOLDER || '',
  ownerId: process.env.HAPPYPAW_OWNER_ID || '',
  runtime: process.env.HAPPYPAW_RUNTIME || '',
  productId: process.env.HAPPYPAW_PRODUCT_ID || '',
  workspaceGroup: process.env.HAPPYPAW_WORKSPACE_GROUP || '',
  workspaceGlobal: process.env.HAPPYPAW_WORKSPACE_GLOBAL || '',
  workspaceMemory: process.env.HAPPYPAW_WORKSPACE_MEMORY || '',
  workspaceIpc: process.env.HAPPYPAW_WORKSPACE_IPC || '',
  isHome: process.env.HAPPYPAW_IS_HOME === '1',
  isAdminHome: process.env.HAPPYPAW_IS_ADMIN_HOME === '1',
  isScheduledTask: process.env.HAPPYPAW_IS_SCHEDULED_TASK === '1',
};

const MESSAGES_DIR = path.join(ctx.workspaceIpc, 'messages');
const TASKS_DIR = path.join(ctx.workspaceIpc, 'tasks');
const ACTIVE_IM_REPLY_ROUTE_FILE = 'active_im_reply_route.json';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function buildToolResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function buildContextText() {
  return [
    `groupFolder=${ctx.groupFolder}`,
    `workspace=${ctx.workspaceGroup}`,
    `ownerId=${ctx.ownerId}`,
    `runtime=${ctx.runtime}`,
    `productId=${ctx.productId}`,
  ].join('\n');
}

function getChannelFromJid(jid) {
  if (jid.startsWith('feishu:')) return 'feishu';
  if (jid.startsWith('telegram:')) return 'telegram';
  if (jid.startsWith('qq:')) return 'qq';
  if (jid.startsWith('wechat:')) return 'wechat';
  return 'web';
}

function collectMemoryFiles(baseDir, out, maxDepth, depth = 0) {
  if (!baseDir || depth > maxDepth || !fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        if (MEMORY_SKIP_DIRS.has(entry.name)) continue;
        if (depth === 0 || MEMORY_SUBDIRS.has(entry.name)) {
          collectMemoryFiles(fullPath, out, maxDepth, depth + 1);
        }
      } else if (entry.isFile()) {
        if (
          entry.name === 'AGENTS.md' ||
          MEMORY_EXTENSIONS.has(path.extname(entry.name))
        ) {
          out.push(fullPath);
        }
      }
    }
  } catch {
    // ignore unreadable directories
  }
}

function toRelativePath(filePath) {
  if (
    ctx.workspaceGlobal &&
    (filePath === ctx.workspaceGlobal ||
      filePath.startsWith(ctx.workspaceGlobal + path.sep))
  ) {
    return `[global] ${path.relative(ctx.workspaceGlobal, filePath)}`;
  }
  if (
    ctx.workspaceMemory &&
    (filePath === ctx.workspaceMemory ||
      filePath.startsWith(ctx.workspaceMemory + path.sep))
  ) {
    return `[memory] ${path.relative(ctx.workspaceMemory, filePath)}`;
  }
  return path.relative(ctx.workspaceGroup, filePath);
}

function parseMemoryFileReference(fileRef) {
  const trimmed = String(fileRef || '').trim();
  const lineRefMatch = trimmed.match(/^(.*?):(\d+)$/);
  if (!lineRefMatch) return { pathRef: trimmed };
  const lineFromRef = Number(lineRefMatch[2]);
  if (!Number.isInteger(lineFromRef) || lineFromRef <= 0) {
    return { pathRef: trimmed };
  }
  return { pathRef: lineRefMatch[1].trim(), lineFromRef };
}

function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = path.join(dir, filename);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
  return filename;
}

async function pollIpcResult(dir, data, resultFilePrefix, timeoutMs = 30_000) {
  const resultFileName = `${resultFilePrefix}_${data.requestId}.json`;
  const resultFilePath = path.join(dir, resultFileName);
  writeIpcFile(dir, data);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(resultFilePath, 'utf8');
      fs.unlinkSync(resultFilePath);
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timeout waiting for IPC result (${timeoutMs / 1000}s)`);
}

function ensureWorkspaceRoot(rootPath, label) {
  if (!rootPath) {
    return buildToolResult(
      `Error: HappyPaw bridge is missing ${label} context. Re-run the conversation so the bridge can be reconfigured for this workspace.`,
      true,
    );
  }
  return null;
}

function resolveWorkspacePath(filePath) {
  const rootError = ensureWorkspaceRoot(ctx.workspaceGroup, 'workspace');
  if (rootError) return { error: rootError };

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(ctx.workspaceGroup, filePath);
  const resolved = path.resolve(absolutePath);
  const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
    ? ctx.workspaceGroup
    : ctx.workspaceGroup + path.sep;
  if (resolved !== ctx.workspaceGroup && !resolved.startsWith(safeRoot)) {
    return {
      error: buildToolResult(
        'Error: file must be within the workspace/group directory.',
        true,
      ),
    };
  }
  return {
    resolved,
    relative: path.relative(ctx.workspaceGroup, resolved),
  };
}

function isPathWithinAnyMemoryRoot(resolvedPath) {
  const roots = [ctx.workspaceGroup, ctx.workspaceGlobal, ctx.workspaceMemory].filter(
    Boolean,
  );
  return roots.some(
    (root) =>
      resolvedPath === root || resolvedPath.startsWith(root + path.sep),
  );
}

function detectImageMimeType(buffer) {
  if (!buffer || buffer.length < 4) return undefined;

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 6 &&
    buffer.toString('ascii', 0, 6).startsWith('GIF8')
  ) {
    return 'image/gif';
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return 'image/tiff';
  }

  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }

  return undefined;
}

function buildUnsupportedChannelMessage(toolName, supportedChannels) {
  const channel = getEffectiveOutboundChannel();
  return buildToolResult(
    `Error: ${toolName} is only supported for ${supportedChannels.join('/')} channels. Current channel "${channel}" is unsupported.`,
    true,
  );
}

function readActiveImReplyRoute() {
  if (!ctx.workspaceIpc || !ctx.groupFolder || !ctx.isHome) return null;
  const snapshotPath = path.join(
    ctx.workspaceIpc,
    ACTIVE_IM_REPLY_ROUTE_FILE,
  );
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    return typeof parsed?.replyJid === 'string' && parsed.replyJid.trim()
      ? parsed.replyJid.trim()
      : null;
  } catch {
    return null;
  }
}

function getEffectiveOutboundImJid() {
  if (getChannelFromJid(ctx.chatJid) !== 'web') return ctx.chatJid;
  return readActiveImReplyRoute();
}

function getEffectiveOutboundChannel() {
  const outboundJid = getEffectiveOutboundImJid();
  return outboundJid ? getChannelFromJid(outboundJid) : getChannelFromJid(ctx.chatJid);
}

function requestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const toolSpecs = [
  {
    name: 'get_context',
    description: 'Return bridge context sourced from process environment variables.',
    schema: z.object({}),
    handler: async () => buildToolResult(buildContextText()),
  },
  {
    name: 'send_message',
    description:
      "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages.",
    schema: z.object({
      text: z.string().describe('The message text to send'),
    }),
    handler: async ({ text }) => {
      const ipcError = ensureWorkspaceRoot(ctx.workspaceIpc, 'IPC');
      if (ipcError) return ipcError;
      const payload = {
        type: 'message',
        chatJid: ctx.chatJid,
        text,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      };
      if (ctx.isScheduledTask) payload.isScheduledTask = true;
      writeIpcFile(MESSAGES_DIR, payload);
      return buildToolResult('Message sent.');
    },
  },
  {
    name: 'send_image',
    description:
      'Send an image file from the workspace to the user or group via IM (Feishu/Telegram).',
    schema: z.object({
      file_path: z
        .string()
        .describe('Path to the image file in the workspace (relative to workspace root or absolute)'),
      caption: z.string().optional().describe('Optional caption text to send with the image'),
    }),
    handler: async ({ file_path, caption }) => {
      const outboundJid = getEffectiveOutboundImJid();
      if (!SUPPORTED_OUTBOUND_IMAGE_CHANNELS.has(getEffectiveOutboundChannel())) {
        return buildUnsupportedChannelMessage('send_image', ['Feishu', 'Telegram']);
      }
      const resolved = resolveWorkspacePath(file_path);
      if (resolved.error) return resolved.error;
      if (!fs.existsSync(resolved.resolved)) {
        return buildToolResult(`Error: file not found: ${file_path}`, true);
      }

      const stat = fs.statSync(resolved.resolved);
      if (stat.size > 10 * 1024 * 1024) {
        return buildToolResult(
          `Error: image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
          true,
        );
      }
      if (stat.size === 0) {
        return buildToolResult('Error: image file is empty.', true);
      }

      const buffer = fs.readFileSync(resolved.resolved);
      const mimeType = detectImageMimeType(buffer);
      if (!mimeType) {
        return buildToolResult(
          'Error: file does not appear to be a supported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).',
          true,
        );
      }

      const payload = {
        type: 'image',
        chatJid: outboundJid || ctx.chatJid,
        imageBase64: buffer.toString('base64'),
        mimeType,
        caption: caption || undefined,
        fileName: path.basename(resolved.resolved),
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      };
      if (ctx.isScheduledTask) payload.isScheduledTask = true;
      writeIpcFile(MESSAGES_DIR, payload);
      return buildToolResult(
        `Image sent: ${path.basename(resolved.resolved)} (${mimeType}, ${(stat.size / 1024).toFixed(1)}KB)`,
      );
    },
  },
  {
    name: 'send_file',
    description:
      'Send a file to the current chat via IM (Feishu/Telegram). Supports files such as PDF, DOC, XLS, PPT, or MP4.',
    schema: z.object({
      filePath: z
        .string()
        .describe('File path relative to workspace/group (e.g., "output/report.pdf")'),
      fileName: z.string().describe('File name to display (e.g., "report.pdf")'),
    }),
    handler: async ({ filePath, fileName }) => {
      const outboundJid = getEffectiveOutboundImJid();
      if (!SUPPORTED_OUTBOUND_FILE_CHANNELS.has(getEffectiveOutboundChannel())) {
        return buildUnsupportedChannelMessage('send_file', ['Feishu', 'Telegram']);
      }
      const resolved = resolveWorkspacePath(filePath);
      if (resolved.error) return resolved.error;
      if (!fs.existsSync(resolved.resolved)) {
        return buildToolResult(`Error: file not found: ${filePath}`, true);
      }
      writeIpcFile(TASKS_DIR, {
        type: 'send_file',
        chatJid: outboundJid || ctx.chatJid,
        filePath: resolved.relative,
        fileName,
        timestamp: new Date().toISOString(),
      });
      return buildToolResult(`Sending file "${fileName}"...`);
    },
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a recurring or one-time task using cron, interval, or once execution.',
    schema: z.object({
      prompt: z.string().optional().default('').describe('Task prompt or description.'),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .describe('cron=recurring at specific times, interval=recurring every N ms, once=run once'),
      schedule_value: z
        .string()
        .describe('cron expression, milliseconds, or local ISO timestamp depending on schedule_type'),
      execution_type: z
        .enum(['agent', 'script'])
        .default('agent')
        .describe('agent=full agent task, script=shell command (admin home only)'),
      script_command: z
        .string()
        .max(4096)
        .optional()
        .describe('Shell command to execute when execution_type is script'),
      context_mode: z
        .enum(['group', 'isolated'])
        .default('isolated')
        .describe('group=runs with chat history, isolated=fresh session'),
      target_group_jid: z
        .string()
        .optional()
        .describe('(Admin home only) JID of the group to schedule the task for'),
    }),
    handler: async (args) => {
      const execType = args.execution_type || 'agent';
      if (execType === 'agent' && !args.prompt?.trim()) {
        return buildToolResult(
          'Agent mode requires a prompt. Provide instructions for what the agent should do.',
          true,
        );
      }
      if (execType === 'script' && !args.script_command?.trim()) {
        return buildToolResult(
          'Script mode requires script_command. Provide the shell command to execute.',
          true,
        );
      }
      if (execType === 'script' && !ctx.isAdminHome) {
        return buildToolResult('Only admin home container can create script tasks.', true);
      }

      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return buildToolResult(
            `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" or "*/5 * * * *".`,
            true,
          );
        }
      } else if (args.schedule_type === 'interval') {
        const ms = parseInt(args.schedule_value, 10);
        if (Number.isNaN(ms) || ms <= 0) {
          return buildToolResult(
            `Invalid interval: "${args.schedule_value}". Must be positive milliseconds.`,
            true,
          );
        }
      } else if (args.schedule_type === 'once') {
        const date = new Date(args.schedule_value);
        if (Number.isNaN(date.getTime())) {
          return buildToolResult(
            `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00".`,
            true,
          );
        }
      }

      const targetJid =
        ctx.isAdminHome && args.target_group_jid ? args.target_group_jid : ctx.chatJid;
      const payload = {
        type: 'schedule_task',
        prompt: args.prompt || '',
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: args.context_mode || 'isolated',
        execution_type: execType,
        targetJid,
        createdBy: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      };
      if (execType === 'script') {
        payload.script_command = args.script_command;
      }
      const filename = writeIpcFile(TASKS_DIR, payload);
      return buildToolResult(
        `Task scheduled [${execType === 'script' ? 'script' : 'agent'}] (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
      );
    },
  },
  {
    name: 'list_tasks',
    description:
      "List scheduled tasks. From admin home it shows all tasks; other groups only see that group's tasks.",
    schema: z.object({}),
    handler: async () => {
      try {
        const result = await pollIpcResult(
          TASKS_DIR,
          {
            type: 'list_tasks',
            requestId: requestId(),
            groupFolder: ctx.groupFolder,
            isAdminHome: ctx.isAdminHome,
            timestamp: new Date().toISOString(),
          },
          'list_tasks_result',
        );
        if (!result.success) {
          return buildToolResult(
            `Error listing tasks: ${result.error || 'Unknown error'}`,
            true,
          );
        }
        const tasks = Array.isArray(result.tasks) ? result.tasks : [];
        if (tasks.length === 0) {
          return buildToolResult('No scheduled tasks found.');
        }
        const formatted = tasks
          .map(
            (task) =>
              `- [${task.id}] ${String(task.prompt || '').slice(0, 50)}... (${task.schedule_type}: ${task.schedule_value}) - ${task.status}, next: ${task.next_run || 'N/A'}`,
          )
          .join('\n');
        return buildToolResult(`Scheduled tasks:\n${formatted}`);
      } catch {
        return buildToolResult('Timeout waiting for task list response.', true);
      }
    },
  },
  {
    name: 'pause_task',
    description: 'Pause a scheduled task.',
    schema: z.object({
      task_id: z.string().describe('The task ID to pause'),
    }),
    handler: async ({ task_id }) => {
      writeIpcFile(TASKS_DIR, {
        type: 'pause_task',
        taskId: task_id,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isAdminHome,
        timestamp: new Date().toISOString(),
      });
      return buildToolResult(`Task ${task_id} pause requested.`);
    },
  },
  {
    name: 'resume_task',
    description: 'Resume a paused task.',
    schema: z.object({
      task_id: z.string().describe('The task ID to resume'),
    }),
    handler: async ({ task_id }) => {
      writeIpcFile(TASKS_DIR, {
        type: 'resume_task',
        taskId: task_id,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isAdminHome,
        timestamp: new Date().toISOString(),
      });
      return buildToolResult(`Task ${task_id} resume requested.`);
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task.',
    schema: z.object({
      task_id: z.string().describe('The task ID to cancel'),
    }),
    handler: async ({ task_id }) => {
      writeIpcFile(TASKS_DIR, {
        type: 'cancel_task',
        taskId: task_id,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isAdminHome,
        timestamp: new Date().toISOString(),
      });
      return buildToolResult(`Task ${task_id} cancellation requested.`);
    },
  },
  {
    name: 'memory_append',
    description:
      'Append short-lived memory to memory/YYYY-MM-DD.md without overwriting existing content.',
    schema: z.object({
      content: z.string().describe('The memory content to append'),
      date: z
        .string()
        .optional()
        .describe('Target date in YYYY-MM-DD format (defaults to today)'),
    }),
    available: () => ctx.isHome,
    handler: async ({ content, date }) => {
      const normalizedContent = content.replace(/\r\n?/g, '\n').trim();
      if (!normalizedContent) {
        return buildToolResult('内容不能为空。', true);
      }
      const appendBytes = Buffer.byteLength(normalizedContent, 'utf8');
      if (appendBytes > MAX_MEMORY_APPEND_SIZE) {
        return buildToolResult(
          `内容过大：${appendBytes} 字节（上限 ${MAX_MEMORY_APPEND_SIZE}）。`,
          true,
        );
      }
      const targetDate = (date ?? new Date().toISOString().split('T')[0]).trim();
      if (!MEMORY_DATE_PATTERN.test(targetDate)) {
        return buildToolResult(
          `日期格式无效：“${targetDate}”，请使用 YYYY-MM-DD。`,
          true,
        );
      }
      const rootError = ensureWorkspaceRoot(ctx.workspaceMemory, 'memory workspace');
      if (rootError) return rootError;
      const resolvedPath = path.normalize(path.join(ctx.workspaceMemory, `${targetDate}.md`));
      const inMemory =
        resolvedPath === ctx.workspaceMemory ||
        resolvedPath.startsWith(ctx.workspaceMemory + path.sep);
      if (!inMemory) {
        return buildToolResult('访问被拒绝：路径超出工作区范围。', true);
      }
      try {
        fs.mkdirSync(ctx.workspaceMemory, { recursive: true });
        const fileExists = fs.existsSync(resolvedPath);
        const currentSize = fileExists ? fs.statSync(resolvedPath).size : 0;
        const separator = currentSize > 0 ? '\n---\n\n' : '';
        const entry = `${separator}### ${new Date().toISOString()}\n${normalizedContent}\n`;
        const nextSize = currentSize + Buffer.byteLength(entry, 'utf8');
        if (nextSize > MAX_MEMORY_FILE_SIZE) {
          return buildToolResult(
            `记忆文件将超过 ${MAX_MEMORY_FILE_SIZE} 字节上限，请缩短内容。`,
            true,
          );
        }
        fs.appendFileSync(resolvedPath, entry, 'utf8');
        return buildToolResult(`已追加到 memory/${targetDate}.md（${appendBytes} 字节）。`);
      } catch (error) {
        return buildToolResult(
          `追加记忆时出错：${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    },
  },
  {
    name: 'memory_search',
    description:
      'Search memory files (AGENTS.md, memory/, conversations/, and other .md/.txt files) in the current workspace.',
    schema: z.object({
      query: z.string().describe('Search keyword or phrase'),
      max_results: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum result count (default 20, max 50)'),
    }),
    handler: async ({ query, max_results }) => {
      if (!query.trim()) {
        return buildToolResult('搜索关键词不能为空。', true);
      }
      const maxResults = Math.min(Math.max(max_results ?? 20, 1), 50);
      const queryLower = query.toLowerCase();
      const files = [];
      collectMemoryFiles(ctx.workspaceMemory, files, 4);
      collectMemoryFiles(ctx.workspaceGroup, files, 4);
      collectMemoryFiles(ctx.workspaceGlobal, files, 4);
      const uniqueFiles = Array.from(new Set(files));
      if (uniqueFiles.length === 0) {
        return buildToolResult('未找到记忆文件。');
      }
      const results = [];
      let skippedLarge = 0;
      for (const filePath of uniqueFiles) {
        if (results.length >= maxResults) break;
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > MAX_MEMORY_FILE_SIZE) {
            skippedLarge++;
            continue;
          }
          const content = fs.readFileSync(filePath, 'utf8');
          const fileLines = content.split('\n');
          let lastEnd = -1;
          for (let index = 0; index < fileLines.length; index++) {
            if (results.length >= maxResults) break;
            if (fileLines[index].toLowerCase().includes(queryLower)) {
              const start = Math.max(0, index - 1);
              if (start <= lastEnd) continue;
              const end = Math.min(fileLines.length, index + 2);
              lastEnd = end;
              results.push(
                `${toRelativePath(filePath)}:${index + 1}\n${fileLines.slice(start, end).join('\n')}`,
              );
            }
          }
        } catch {
          // ignore unreadable files
        }
      }
      const skippedNote = skippedLarge > 0 ? `（跳过 ${skippedLarge} 个大文件）` : '';
      if (results.length === 0) {
        return buildToolResult(
          `在 ${uniqueFiles.length} 个记忆文件中未找到“${query}”的匹配。${skippedNote}`,
        );
      }
      return buildToolResult(`找到 ${results.length} 条匹配${skippedNote}：\n\n${results.join('\n---\n')}`);
    },
  },
  {
    name: 'memory_get',
    description: 'Read a memory file or specific line range after memory_search.',
    schema: z.object({
      file: z
        .string()
        .describe('Relative path, optionally with :line (e.g. "AGENTS.md:12" or "[memory] 2026-01-15.md")'),
      from_line: z.number().optional().describe('Starting line number (1-based)'),
      lines: z.number().optional().describe('Number of lines to read (max 200)'),
    }),
    handler: async ({ file, from_line, lines: lineCount }) => {
      const { pathRef, lineFromRef } = parseMemoryFileReference(file);
      let resolvedPath;
      if (pathRef.startsWith('[global] ')) {
        resolvedPath = path.join(ctx.workspaceGlobal, pathRef.slice('[global] '.length));
      } else if (pathRef.startsWith('[memory] ')) {
        resolvedPath = path.join(ctx.workspaceMemory, pathRef.slice('[memory] '.length));
      } else {
        resolvedPath = path.join(ctx.workspaceGroup, pathRef);
      }
      resolvedPath = path.normalize(resolvedPath);
      if (!isPathWithinAnyMemoryRoot(resolvedPath)) {
        return buildToolResult('访问被拒绝：路径超出工作区范围。', true);
      }
      if (!fs.existsSync(resolvedPath)) {
        return buildToolResult(`文件未找到：${pathRef}`, true);
      }
      try {
        const content = fs.readFileSync(resolvedPath, 'utf8');
        const allLines = content.split('\n');
        const startLine = Math.max((from_line ?? lineFromRef ?? 1) - 1, 0);
        const maxLines = Math.min(lineCount ?? allLines.length, 200);
        const slice = allLines.slice(startLine, startLine + maxLines);
        return buildToolResult(
          `${pathRef}（第 ${startLine + 1}-${startLine + slice.length} 行，共 ${allLines.length} 行）\n\n${slice.join('\n')}`,
        );
      } catch (error) {
        return buildToolResult(
          `读取文件时出错：${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    },
  },
];

function getAvailableToolSpecs() {
  return toolSpecs.filter((tool) => (typeof tool.available === 'function' ? tool.available() : true));
}

function buildToolDefinitions() {
  return getAvailableToolSpecs().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.schema.toJSONSchema(),
  }));
}

async function handleToolCall(name, args) {
  const tool = getAvailableToolSpecs().find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return buildToolResult(
      `Invalid arguments for ${name}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      true,
    );
  }
  return tool.handler(parsed.data);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  lines.push(...chunk.split('\n'));
  while (lines.length > 1) {
    const raw = lines.shift();
    if (!raw || !raw.trim()) continue;

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }

    const respondError = (error) => {
      if (message.id === undefined) return;
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    };

    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'happypaw-codex-bridge',
            version: '1.0.0',
          },
        },
      });
      continue;
    }

    if (
      message.method === 'initialized' ||
      message.method === 'notifications/initialized'
    ) {
      continue;
    }

    if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: buildToolDefinitions() },
      });
      continue;
    }

    if (message.method === 'tools/call') {
      Promise.resolve()
        .then(async () => {
          const result = await handleToolCall(
            message.params?.name,
            message.params?.arguments ?? {},
          );
          send({
            jsonrpc: '2.0',
            id: message.id,
            result,
          });
        })
        .catch((error) => {
          if (error instanceof Error && error.message.startsWith('Unknown tool:')) {
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32601,
                message: error.message,
              },
            });
            return;
          }
          respondError(error);
        });
      continue;
    }

    if (message.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unsupported method: ${message.method}` },
      });
    }
  }
});

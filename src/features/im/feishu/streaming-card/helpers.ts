import * as lark from '@larksuiteoapi/node-sdk';
import { optimizeMarkdownStyle } from '../markdown-style.js';

// ─── Types ────────────────────────────────────────────────────

export type StreamingState =
  | 'idle'
  | 'creating'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error';

export interface StreamingCardOptions {
  /** Lark SDK client instance */
  client: lark.Client;
  /** Chat ID to send the card to */
  chatId: string;
  /** Reply to this message ID (optional) */
  replyToMsgId?: string;
  /** Called when the card is created or streaming fails */
  onFallback?: () => void;
  /** Called when the initial card is created and messageId is available */
  onCardCreated?: (messageId: string) => void;
}

// ─── Code-Block-Safe Splitting ───────────────────────────────

interface CodeBlockRange {
  open: number;
  close: number;
  lang: string;
}

/**
 * Scan text for fenced code block ranges (``` ... ```).
 */
function findCodeBlockRanges(text: string): CodeBlockRange[] {
  const ranges: CodeBlockRange[] = [];
  const regex = /^```(\w*)\s*$/gm;
  let match: RegExpExecArray | null;
  let openMatch: RegExpExecArray | null = null;
  let openLang = '';

  while ((match = regex.exec(text)) !== null) {
    if (!openMatch) {
      openMatch = match;
      openLang = match[1] || '';
    } else {
      ranges.push({
        open: openMatch.index,
        close: match.index + match[0].length,
        lang: openLang,
      });
      openMatch = null;
      openLang = '';
    }
  }

  // Unclosed code block — treat from open to end of text
  if (openMatch) {
    ranges.push({
      open: openMatch.index,
      close: text.length,
      lang: openLang,
    });
  }

  return ranges;
}

/**
 * Check if a position falls inside any code block range.
 * Returns the range if found, null otherwise.
 */
function findContainingBlock(
  pos: number,
  ranges: CodeBlockRange[],
): CodeBlockRange | null {
  for (const r of ranges) {
    if (pos > r.open && pos < r.close) return r;
  }
  return null;
}

/**
 * Split text respecting fenced code block boundaries.
 * Unlike splitAtParagraphs(), this never truncates inside a code block
 * without properly closing/reopening the fence.
 */
export function splitCodeBlockSafe(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Recompute ranges on current remaining text each iteration.
    // This handles synthetic reopeners correctly since all positions
    // are relative to `remaining`, not the original text.
    const ranges = findCodeBlockRanges(remaining);

    // Find a split point around maxLen
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    const block = findContainingBlock(idx, ranges);

    if (block) {
      // Split point is inside a code block
      if (block.open > 0 && block.open > maxLen * 0.3) {
        // Retreat to just before the code block opening
        const retreatIdx = remaining.lastIndexOf('\n', block.open);
        idx = retreatIdx > maxLen * 0.3 ? retreatIdx : block.open;
        chunks.push(remaining.slice(0, idx).trimEnd());
        remaining = remaining.slice(idx).replace(/^\n+/, '');
      } else {
        // Block starts too early to retreat — split inside but close/reopen fence
        const chunk = remaining.slice(0, idx).trimEnd() + '\n```';
        chunks.push(chunk);
        const reopener = '```' + block.lang + '\n';
        remaining = reopener + remaining.slice(idx).replace(/^\n/, '');
      }
    } else {
      chunks.push(remaining.slice(0, idx).trimEnd());
      remaining = remaining.slice(idx).replace(/^\n+/, '');
    }
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export const CARD_MD_LIMIT = 4000;
export const CARD_SIZE_LIMIT = 25 * 1024; // Feishu limit ~30KB, 5KB safety margin

// ─── Legacy Card Builder (Fallback) ──────────────────────────

function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function extractTitleAndBody(text: string): {
  title: string;
  body: string;
} {
  const lines = text.split('\n');
  let title = '';
  let bodyStartIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^#{1,3}\s+/.test(lines[i])) {
      title = lines[i].replace(/^#+\s*/, '').trim();
      bodyStartIdx = i + 1;
    }
    break;
  }

  const body = lines.slice(bodyStartIdx).join('\n').trim();

  if (!title) {
    const firstLine = (lines.find((l) => l.trim()) || '')
      .replace(/[*_`#\[\]]/g, '')
      .trim();
    title =
      firstLine.length > 40
        ? firstLine.slice(0, 37) + '...'
        : firstLine || 'Reply';
  }

  return { title, body };
}

// ─── Shared Card Content Builder ─────────────────────────────

interface CardContentResult {
  title: string;
  contentElements: Array<Record<string, unknown>>;
}

/**
 * Build the content elements shared by both Legacy and Schema 2.0 card builders.
 * Splits long text, handles `---` section dividers, and extracts the title.
 * Applies optimizeMarkdownStyle() for proper Feishu rendering.
 */
export function buildCardContent(
  text: string,
  splitFn: (text: string, maxLen: number) => string[],
  overrideTitle?: string,
): CardContentResult {
  const { title: extractedTitle, body } = extractTitleAndBody(text);
  const title = overrideTitle || extractedTitle;
  // Apply Markdown optimization for Feishu card rendering
  const rawContent = body || text.trim();
  const contentToRender = optimizeMarkdownStyle(rawContent, 2);
  const elements: Array<Record<string, unknown>> = [];

  if (contentToRender.length > CARD_MD_LIMIT) {
    for (const chunk of splitFn(contentToRender, CARD_MD_LIMIT)) {
      elements.push({ tag: 'markdown', content: chunk });
    }
  } else if (contentToRender) {
    // Keep --- as markdown content instead of using { tag: 'hr' }
    // because Schema 2.0 (CardKit) does not support the hr tag.
    elements.push({ tag: 'markdown', content: contentToRender });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text.trim() || '...' });
  }

  return { title, contentElements: elements };
}

// ─── Interrupt Button Element ────────────────────────────────

/** Schema 1.0: `action` container wrapping a button (used by legacy message.patch path) */
const INTERRUPT_BUTTON = {
  tag: 'action',
  actions: [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '⏹ 中断回复' },
      type: 'danger',
      value: { action: 'interrupt_stream' },
    },
  ],
} as const;

/** Schema 2.0: standalone button (CardKit rejects `tag: 'action'` in v2 cards) */
const INTERRUPT_BUTTON_V2 = {
  tag: 'button',
  text: { tag: 'plain_text', content: '⏹ 中断回复' },
  type: 'danger',
  value: { action: 'interrupt_stream' },
} as const;

// ─── Streaming Mode Constants ─────────────────────────────────

export const ELEMENT_IDS = {
  AUX_BEFORE: 'aux_before',
  MAIN_CONTENT: 'main_content',
  AUX_AFTER: 'aux_after',
  INTERRUPT_BTN: 'interrupt_btn',
  STATUS_NOTE: 'status_note',
} as const;

export const STREAMING_CONFIG = {
  print_frequency_ms: { default: 50 },
  print_step: { default: 2 },
  print_strategy: 'fast' as const,
};

export const MAX_STREAMING_CONTENT = 100000; // cardElement.content() supports 100K chars

// ─── Tool Progress & Elapsed Helpers ─────────────────────────

/** Extended tool call state with timing and parameter summary */
export interface ToolCallState {
  name: string;
  status: 'running' | 'complete' | 'error';
  startTime: number;
  toolInputSummary?: string;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.floor(sec % 60)}s`;
}

// ─── Auxiliary State & Builder ────────────────────────────────

export const MAX_THINKING_CHARS = 800;
export const MAX_RECENT_EVENTS = 5;
export const MAX_TOOL_DISPLAY = 5;
export const MAX_TODO_DISPLAY = 10;
export const MAX_TOOL_SUMMARY_CHARS = 60;
export const MAX_ELEMENT_CHARS = 4000;
export const MAX_COMPLETED_TOOL_AGE = 30000; // 30s — purge completed tools after this

export interface AuxiliaryState {
  thinkingText: string;
  isThinking: boolean;
  toolCalls: Map<string, ToolCallState>;
  systemStatus: string | null;
  activeHook: { hookName: string; hookEvent: string } | null;
  todos: Array<{ id: string; content: string; status: string }> | null;
  recentEvents: Array<{ text: string }>;
}

/**
 * Build auxiliary markdown elements for the streaming card.
 * Returns elements to insert before and after the main text content.
 */
export function buildAuxiliaryElements(aux: AuxiliaryState): {
  before: Array<Record<string, unknown>>;
  after: Array<Record<string, unknown>>;
} {
  const before: Array<Record<string, unknown>> = [];
  const after: Array<Record<string, unknown>> = [];

  // ① System Status
  if (aux.systemStatus) {
    before.push({
      tag: 'markdown',
      content: `⏳ ${aux.systemStatus}`.slice(0, MAX_ELEMENT_CHARS),
      text_size: 'notation',
    });
  }

  // ② Thinking
  if (aux.isThinking && aux.thinkingText) {
    const truncated =
      aux.thinkingText.length > MAX_THINKING_CHARS
        ? '...' + aux.thinkingText.slice(-(MAX_THINKING_CHARS - 3))
        : aux.thinkingText;
    // Escape content for blockquote (each line gets "> " prefix)
    const quoted = truncated
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    before.push({
      tag: 'markdown',
      content: `💭 **Reasoning...**\n${quoted}`.slice(0, MAX_ELEMENT_CHARS),
      text_size: 'notation',
    });
  } else if (aux.isThinking) {
    before.push({
      tag: 'markdown',
      content: '💭 **Thinking...**',
      text_size: 'notation',
    });
  }

  // ③ Active Tools (running first, then recent completed, max MAX_TOOL_DISPLAY)
  const now = Date.now();
  const running: Array<[string, ToolCallState]> = [];
  const completed: Array<[string, ToolCallState]> = [];
  for (const [id, tc] of aux.toolCalls) {
    if (tc.status === 'running') running.push([id, tc]);
    else completed.push([id, tc]);
  }
  // Show running tools first, fill remaining slots with latest completed
  const display = [
    ...running,
    ...completed.slice(-Math.max(0, MAX_TOOL_DISPLAY - running.length)),
  ].slice(0, MAX_TOOL_DISPLAY);

  if (display.length > 0) {
    const lines = display.map(([, tc]) => {
      const icon =
        tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
      const elapsed = formatElapsed(now - tc.startTime);
      let summary = '';
      if (tc.toolInputSummary) {
        const s =
          tc.toolInputSummary.length > MAX_TOOL_SUMMARY_CHARS
            ? tc.toolInputSummary.slice(0, MAX_TOOL_SUMMARY_CHARS) + '...'
            : tc.toolInputSummary;
        summary = `  ${s}`;
      }
      return `${icon} \`${tc.name}\` (${elapsed})${summary}`;
    });
    before.push({
      tag: 'markdown',
      content: lines.join('\n').slice(0, MAX_ELEMENT_CHARS),
      text_size: 'notation',
    });
  }

  // ④ Hook Status
  if (aux.activeHook) {
    before.push({
      tag: 'markdown',
      content: `🔗 Hook: ${aux.activeHook.hookName || aux.activeHook.hookEvent}`,
      text_size: 'notation',
    });
  }

  // ⑤ Todo Progress
  if (aux.todos && aux.todos.length > 0) {
    const total = aux.todos.length;
    const done = aux.todos.filter((t) => t.status === 'completed').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const header = `📋 **${done}/${total} (${pct}%)**`;
    const items = aux.todos.slice(0, MAX_TODO_DISPLAY).map((t) => {
      const icon =
        t.status === 'completed'
          ? '✅'
          : t.status === 'in_progress'
            ? '⏳'
            : '○';
      return `${icon} ${t.content}`;
    });
    const extra =
      total > MAX_TODO_DISPLAY ? `\n... +${total - MAX_TODO_DISPLAY} 项` : '';
    before.push({
      tag: 'markdown',
      content: `${header}\n${items.join('\n')}${extra}`.slice(
        0,
        MAX_ELEMENT_CHARS,
      ),
      text_size: 'notation',
    });
  }

  // ⑦ Recent Events (call trace)
  if (aux.recentEvents.length > 0) {
    const lines = aux.recentEvents.map((e) => `- ${e.text}`);
    after.push({
      tag: 'markdown',
      content: `📝 **调用轨迹**\n${lines.join('\n')}`.slice(
        0,
        MAX_ELEMENT_CHARS,
      ),
      text_size: 'notation',
    });
  }

  return { before, after };
}

// ─── Legacy Card Builder (Fallback) ──────────────────────────

export function buildStreamingCard(
  text: string,
  state: 'streaming' | 'completed' | 'aborted',
  footerNote?: string,
): object {
  const { title, contentElements: elements } = buildCardContent(
    text,
    splitAtParagraphs,
  );

  const noteMap = {
    streaming: '⏳ 生成中...',
    completed: '',
    aborted: '⚠️ 已中断',
  };
  const headerTemplate = {
    streaming: 'wathet',
    completed: 'indigo',
    aborted: 'orange',
  };

  if (state === 'streaming') {
    elements.push(INTERRUPT_BUTTON);
  }

  if (noteMap[state]) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: noteMap[state] }],
    });
  }

  if (footerNote) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: footerNote }],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: headerTemplate[state],
    },
    elements,
  };
}

// ─── Schema 2.0 Card Builder ─────────────────────────────────

export type Schema2State = 'streaming' | 'completed' | 'aborted' | 'frozen';

export const SCHEMA2_NOTE_MAP: Record<Schema2State, string> = {
  streaming: '⏳ 生成中...',
  completed: '',
  aborted: '⚠️ 已中断',
  frozen: '',
};

const SCHEMA2_HEADER_MAP: Record<Schema2State, string> = {
  streaming: 'wathet',
  completed: 'indigo',
  aborted: 'orange',
  frozen: 'grey',
};

export function buildSchema2Card(
  text: string,
  state: Schema2State,
  titlePrefix = '',
  overrideTitle?: string,
  auxiliaryState?: AuxiliaryState,
  footerNote?: string,
): object {
  const { title, contentElements } = buildCardContent(
    text,
    splitCodeBlockSafe,
    overrideTitle,
  );
  const displayTitle = titlePrefix ? `${titlePrefix}${title}` : title;

  // Build final elements array with auxiliary sections
  const elements: Array<Record<string, unknown>> = [];

  if (auxiliaryState) {
    const { before, after } = buildAuxiliaryElements(auxiliaryState);
    elements.push(...before);
    elements.push(...contentElements);
    elements.push(...after);
  } else {
    elements.push(...contentElements);
  }

  if (state === 'streaming') {
    elements.push(INTERRUPT_BUTTON_V2);
  }

  if (SCHEMA2_NOTE_MAP[state]) {
    elements.push({
      tag: 'markdown',
      content: SCHEMA2_NOTE_MAP[state],
      text_size: 'notation',
    });
  }

  if (footerNote) {
    elements.push({
      tag: 'markdown',
      content: footerNote,
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      summary: { content: displayTitle },
    },
    header: {
      title: { tag: 'plain_text', content: displayTitle },
      template: SCHEMA2_HEADER_MAP[state],
    },
    body: { elements },
  };
}

// ─── Usage Note Formatter ─────────────────────────────────────

export function formatUsageNote(usage: {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
}): string {
  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  const parts: string[] = [];
  parts.push(`${fmt(usage.inputTokens)} / ${fmt(usage.outputTokens)} tokens`);
  if (usage.costUSD > 0) parts.push(`$${usage.costUSD.toFixed(4)}`);
  if (usage.durationMs > 0)
    parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  if (usage.numTurns > 1) parts.push(`${usage.numTurns} turns`);
  return `💰 ${parts.join(' · ')}`;
}

// ─── Streaming Mode Card Builder ──────────────────────────────

export function buildStreamingModeCard(initialText: string): object {
  const { title } = extractTitleAndBody(initialText);
  const displayTitle = title || '...';
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      summary: { content: displayTitle },
      streaming_mode: true,
      streaming_config: STREAMING_CONFIG,
    },
    header: {
      title: { tag: 'plain_text', content: displayTitle },
      template: 'wathet',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          element_id: ELEMENT_IDS.AUX_BEFORE,
          text_size: 'notation',
        },
        {
          tag: 'markdown',
          content: initialText || '...',
          element_id: ELEMENT_IDS.MAIN_CONTENT,
        },
        {
          tag: 'markdown',
          content: '',
          element_id: ELEMENT_IDS.AUX_AFTER,
          text_size: 'notation',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '⏹ 中断回复' },
          type: 'danger',
          value: { action: 'interrupt_stream' },
          element_id: ELEMENT_IDS.INTERRUPT_BTN,
        },
        {
          tag: 'markdown',
          content: '⏳ 生成中...',
          element_id: ELEMENT_IDS.STATUS_NOTE,
          text_size: 'notation',
        },
      ],
    },
  };
}

/**
 * Serialize auxiliary element array into a single markdown string.
 * Reuses output from buildAuxiliaryElements().
 */
export function serializeAuxContent(
  elements: Array<Record<string, unknown>>,
): string {
  return elements
    .map((e) => (e as { content?: string }).content || '')
    .filter(Boolean)
    .join('\n\n');
}

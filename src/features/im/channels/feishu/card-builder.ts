import { optimizeMarkdownStyle } from './markdown-style.js';

const CARD_MD_LIMIT = 4000;
export const CARD_TABLE_LIMIT = 5;

function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Prefer splitting at double newline (paragraph break)
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) {
      // Fallback to single newline
      idx = remaining.lastIndexOf('\n', maxLen);
    }
    if (idx < maxLen * 0.3) {
      // Hard split as last resort
      idx = maxLen;
    }
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

/**
 * Map file extension to Feishu file type.
 */
export function getFileType(
  ext: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const map: Record<
    string,
    'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
  > = {
    '.pdf': 'pdf',
    '.doc': 'doc',
    '.docx': 'doc',
    '.xls': 'xls',
    '.xlsx': 'xls',
    '.ppt': 'ppt',
    '.pptx': 'ppt',
    '.mp4': 'mp4',
    '.opus': 'opus',
  };
  return map[ext.toLowerCase()] || 'stream';
}

/**
 * Build a Feishu interactive card (Schema 2.0) from markdown text.
 * Applies optimizeMarkdownStyle() for proper rendering in Feishu cards:
 * - Heading demotion (H1→H4, H2~H6→H5)
 * - Code block / table spacing with <br>
 * - Invalid image cleanup
 */
/** Build a post+md fallback content string for when interactive card send fails. */
export function buildPostMdFallback(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text: optimizeMarkdownStyle(text, 1) }]],
    },
  });
}

export function buildInteractiveCard(text: string): object {
  const optimized = optimizeMarkdownStyle(text, 2);
  const lines = text.split('\n');
  let title = '';
  let bodyStartIdx = 0;

  // Extract title from first heading if present (use original text for title)
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^#{1,3}\s+/.test(lines[i])) {
      title = lines[i].replace(/^#+\s*/, '').trim();
      bodyStartIdx = i + 1;
    }
    break;
  }

  // Apply optimizeMarkdownStyle to body (title was already extracted from original)
  const optimizedLines = optimized.split('\n');
  // Skip lines corresponding to the title in optimized text
  let optimizedBody: string;
  if (bodyStartIdx > 0) {
    // Find the first non-empty line in optimized text and skip it (it's the demoted title)
    let skipIdx = 0;
    for (let i = 0; i < optimizedLines.length; i++) {
      if (!optimizedLines[i].trim()) continue;
      skipIdx = i + 1;
      break;
    }
    optimizedBody = optimizedLines.slice(skipIdx).join('\n').trim();
  } else {
    optimizedBody = optimized.trim();
  }

  // Generate title if no heading found — use first line preview
  if (!title) {
    const firstLine = (lines.find((l) => l.trim()) || '')
      .replace(/[*_`#\[\]]/g, '')
      .trim();
    title =
      firstLine.length > 40
        ? firstLine.slice(0, 37) + '...'
        : firstLine || 'Reply';
  }

  // Build card elements
  const elements: Array<Record<string, unknown>> = [];
  const contentToRender = optimizedBody || optimized.trim();

  if (contentToRender.length > CARD_MD_LIMIT) {
    // Long content: split into multiple markdown elements
    const chunks = splitAtParagraphs(contentToRender, CARD_MD_LIMIT);
    for (const chunk of chunks) {
      elements.push({ tag: 'markdown', content: chunk });
    }
  } else if (contentToRender) {
    // Split by horizontal rules for visual sections
    const sections = contentToRender.split(/\n-{3,}\n/);
    for (let i = 0; i < sections.length; i++) {
      if (i > 0) elements.push({ tag: 'hr' });
      const s = sections[i].trim();
      if (s) elements.push({ tag: 'markdown', content: s });
    }
  }

  // Ensure at least one element
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: optimized.trim() });
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      summary: { content: title },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'indigo',
    },
    body: { elements },
  };
}

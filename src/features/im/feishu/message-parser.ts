import { logger } from '../../../logger.js';

interface FeishuFileInfo {
  fileKey: string;
  filename: string;
}

export function extractMessageContent(
  messageType: string,
  content: string,
): { text: string; imageKeys?: string[]; fileInfos?: FeishuFileInfo[] } {
  // merge_forward: WebSocket 推送的内容是纯字符串 "Merged and Forwarded Message"（非 JSON），
  // 必须在 JSON.parse 之前单独处理，否则 parse 失败导致消息被丢弃
  if (messageType === 'merge_forward') {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { text: '[合并转发消息]' };
    }
    const items = parsed.message_list || parsed.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return { text: '[合并转发消息]' };
    }
    const lines: string[] = ['[合并转发消息]:'];
    for (const item of items.slice(0, 20)) {
      const sender = item.sender_name || item.sender || '未知';
      const body = item.body?.content || item.content || '';
      let text = '';
      try {
        const subType = item.msg_type || item.message_type || 'text';
        const sub = extractMessageContent(subType, body);
        text = sub.text || '';
      } catch {
        text = typeof body === 'string' ? body : '';
      }
      if (text) {
        lines.push(`> ${sender}: ${text.split('\n')[0].slice(0, 200)}`);
      }
    }
    if (items.length > 20) {
      lines.push(`> ... 共 ${items.length} 条消息`);
    }
    return { text: lines.join('\n') };
  }

  try {
    const parsed = JSON.parse(content);

    if (messageType === 'text') {
      return { text: parsed.text || '' };
    }

    if (messageType === 'post') {
      // Extract text and inline images from rich post content.
      const lines: string[] = [];
      const imageKeys: string[] = [];
      // 飞书 post 消息有三种已知格式：
      // 1. 带 post + 语言包裹：{"post": {"zh_cn": {"title": "...", "content": [[...]]}}}
      // 2. 仅语言包裹：{"zh_cn": {"title": "...", "content": [[...]]}}
      // 3. 无包裹（直接 title+content）：{"title": "...", "content": [[...]]}
      const post = parsed.post || parsed;
      if (!post || typeof post !== 'object') {
        logger.warn(
          { keys: Object.keys(parsed) },
          'Empty post object in post message',
        );
        return { text: '' };
      }

      // 判断 contentData：如果 post 本身就有 content 数组，直接用；否则查找语言层
      let contentData: any;
      if (Array.isArray(post.content)) {
        // 格式 3：无包裹，post 本身就是 {title, content}
        contentData = post;
        logger.debug('Post message using flat format (no locale wrapper)');
      } else {
        // 格式 1/2：有语言层包裹
        contentData = post.zh_cn || post.en_us || Object.values(post)[0];
      }
      if (!contentData || !Array.isArray(contentData.content)) {
        logger.warn(
          { keys: Object.keys(post) },
          'Missing content array in post message',
        );
        return { text: '' };
      }

      // Include post title if present
      if (contentData.title && typeof contentData.title === 'string') {
        lines.push(contentData.title);
      }

      for (const paragraph of contentData.content) {
        // Handle both array paragraphs and flat object segments
        const segments = Array.isArray(paragraph)
          ? paragraph
          : paragraph && typeof paragraph === 'object'
            ? [paragraph]
            : null;
        if (!segments) continue;
        const parts: string[] = [];
        for (const segment of segments) {
          if (!segment || typeof segment !== 'object') continue;
          if (segment.tag === 'text' && typeof segment.text === 'string') {
            parts.push(segment.text);
          } else if (segment.tag === 'a' && typeof segment.text === 'string') {
            parts.push(segment.text);
          } else if (segment.tag === 'at') {
            const mentionName =
              typeof segment.user_name === 'string'
                ? segment.user_name
                : typeof segment.text === 'string'
                  ? segment.text
                  : typeof segment.name === 'string'
                    ? segment.name
                    : '用户';
            parts.push(`@${mentionName}`);
          } else if (
            segment.tag === 'img' &&
            typeof segment.image_key === 'string'
          ) {
            imageKeys.push(segment.image_key);
            parts.push('[图片]');
          } else if (segment.tag === 'media') {
            parts.push('[视频]');
          } else if (
            segment.tag === 'emotion' &&
            typeof segment.emoji_type === 'string'
          ) {
            parts.push(`:${segment.emoji_type}:`);
          } else if (typeof segment.text === 'string') {
            parts.push(segment.text);
          }
        }
        if (parts.length > 0) lines.push(parts.join(''));
      }

      return {
        text: lines.join('\n'),
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
      };
    }

    if (messageType === 'image') {
      const imageKey = parsed.image_key;
      if (imageKey) {
        return { text: '', imageKeys: [imageKey] };
      }
    }

    if (messageType === 'file') {
      const fileKey = parsed.file_key;
      const filename = parsed.file_name || '';
      if (fileKey) {
        return {
          text: `[文件: ${filename || fileKey}]`,
          fileInfos: [{ fileKey, filename }],
        };
      }
    }

    if (messageType === 'sticker') {
      const stickerDesc = parsed.description || parsed.sticker_id || '表情包';
      return { text: `[表情包: ${stickerDesc}]` };
    }

    if (messageType === 'audio') {
      const duration = parsed.duration
        ? `${Math.round(parsed.duration / 1000)}s`
        : '';
      return { text: `[语音消息${duration ? ': ' + duration : ''}]` };
    }

    if (messageType === 'share_chat') {
      const chatName = parsed.chat_name || parsed.chat_id || '未知群聊';
      return { text: `[分享群聊: ${chatName}]` };
    }

    if (messageType === 'share_user') {
      const userName = parsed.user_name || parsed.user_id || '未知用户';
      return { text: `[分享用户: ${userName}]` };
    }

    if (messageType === 'system') {
      const body = parsed.body || parsed.content || '';
      const systemText = typeof body === 'string' ? body : JSON.stringify(body);
      return { text: `[系统消息: ${systemText.slice(0, 200)}]` };
    }

    if (messageType === 'interactive') {
      // Extract title and text elements from interactive card messages
      const parts: string[] = [];
      if (parsed.title) {
        parts.push(parsed.title);
      }
      if (Array.isArray(parsed.elements)) {
        for (const row of parsed.elements) {
          if (!Array.isArray(row)) continue;
          for (const el of row) {
            if (!el || typeof el !== 'object') continue;
            if (el.tag === 'text' && typeof el.text === 'string') {
              parts.push(el.text);
            } else if (el.tag === 'a' && typeof el.text === 'string') {
              parts.push(`[${el.text}](${el.href || ''})`);
            } else if (el.tag === 'note' && Array.isArray(el.elements)) {
              const noteText = el.elements
                .filter(
                  (n: any) => n.tag === 'text' && typeof n.text === 'string',
                )
                .map((n: any) => n.text)
                .join('');
              if (noteText) parts.push(noteText);
            }
            // Skip buttons, hr, select_static, img — not useful as text
          }
        }
      }
      const cardText = parts.filter(Boolean).join('\n');
      return { text: cardText || '[飞书卡片消息]' };
    }

    if (messageType === 'media') {
      return { text: '[视频消息]' };
    }

    if (messageType === 'location') {
      return {
        text: `[位置: ${parsed.name || parsed.address || '未知位置'}]`,
      };
    }

    if (messageType === 'share_calendar_event') {
      return {
        text: `[日程分享: ${parsed.summary || parsed.event_id || ''}]`,
      };
    }

    if (messageType === 'video_chat') {
      return { text: `[视频会议: ${parsed.topic || ''}]` };
    }

    if (messageType === 'todo') {
      return {
        text: `[待办: ${parsed.task_id || parsed.summary || ''}]`,
      };
    }

    if (messageType === 'hongbao') {
      return { text: '[红包消息]' };
    }

    // 未知消息类型：返回类型占位符，避免静默丢弃
    return { text: `[${messageType}]` };
  } catch (err) {
    logger.warn(
      { err, messageType, content },
      'Failed to parse message content',
    );
    return { text: `[${messageType}]` };
  }
}

/**
 * Split long text at paragraph boundaries to fit within card element limits.
 */

import fs from 'fs';
import path from 'path';

import { getChannelFromJid } from '../shared/im/channel-prefixes.js';
import type { ContainerInput } from '../types.js';
import type { RuntimeDeps } from './shared.js';

const GLOBAL_AGENTS_MD_MAX_CHARS = 8000;

export function buildRuntimePromptContext(
  deps: RuntimeDeps,
  containerInput: ContainerInput,
  memoryRecall: string,
): { extraDirs: string[]; systemPromptAppend: string } {
  const { isHome } = deps.normalizeHomeFlags(containerInput);
  const globalMemoryFilePath = path.join(deps.WORKSPACE_GLOBAL, 'AGENTS.md');

  let globalMemoryContent = '';
  if (isHome && fs.existsSync(globalMemoryFilePath)) {
    globalMemoryContent = fs.readFileSync(globalMemoryFilePath, 'utf-8');
    globalMemoryContent = deps.truncateWithHeadTail(
      globalMemoryContent,
      GLOBAL_AGENTS_MD_MAX_CHARS,
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
        '2. **默认把正式答复整合为一条最终输出** — 除非需要侧边进度/状态同步，不要把完整结论拆成多条普通回复',
        '3. **允许使用 `send_message` 发送侧边消息**：',
        '   - 当任务仍在进行、需要向用户同步进度、阶段结果、阻塞或下一步计划时，可以立即发送',
        '   - 当用户明确要求你先回一条、分步骤汇报，或中途告知状态时，可以立即发送',
        '   - 侧边消息应简洁、有信息量，不要发送空泛确认或重复内容',
        '4. **`send_message` 之后继续完成当前回合** — 正常文本输出仍会作为该回合的最终回复单独发送',
        '5. **回复语言使用简体中文**，除非用户用其他语言提问',
      ].join('\n')
    : '';

  const channelGuidelines = deps.buildChannelGuidelines(
    getChannelFromJid(containerInput.replyRouteJid || containerInput.chatJid),
  );

  const systemPromptAppend = [
    globalMemoryContent &&
      `<user-profile>\n${globalMemoryContent}\n</user-profile>`,
    `<behavior>\n${interactionGuidelines}\n</behavior>`,
    `<security>\n${deps.SECURITY_RULES}\n</security>`,
    `<memory-system>\n${memoryRecall}\n</memory-system>`,
    heartbeatContent && `<recent-work>\n${heartbeatContent}\n</recent-work>`,
    `<output-format>\n${outputGuidelines}\n</output-format>`,
    `<web-access>\n${webFetchGuidelines}\n</web-access>`,
    `<background-tasks>\n${backgroundTaskGuidelines}\n</background-tasks>`,
    channelGuidelines &&
      `<channel-format>\n${channelGuidelines}\n</channel-format>`,
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

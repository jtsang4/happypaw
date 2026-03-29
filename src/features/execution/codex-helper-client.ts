import { getCodexProviderConfigWithSource } from '../../runtime-config.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_HELPER_MODEL = 'gpt-5.1-mini';

export class CodexHelperError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'CodexHelperError';
    this.statusCode = statusCode;
  }
}

function resolveResponsesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return `${normalized}/responses`;
}

function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';

  const outputText = (payload as { output_text?: unknown }).output_text;
  if (typeof outputText === 'string' && outputText.trim()) {
    return outputText.trim();
  }

  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if ((item as { type?: unknown }).type !== 'message') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      if ((entry as { type?: unknown }).type !== 'output_text') continue;
      const text = (entry as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) {
        parts.push(text.trim());
      }
    }
  }

  return parts.join('\n').trim();
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}

export async function requestCodexHelperJson<T>(
  prompt: string,
  purposeLabel: string,
): Promise<T> {
  const { config } = getCodexProviderConfigWithSource();
  const apiKey = config.openaiApiKey.trim();
  if (!apiKey) {
    throw new CodexHelperError(
      '尚未配置 Codex API Key，无法使用该智能助手',
      503,
    );
  }

  const baseUrl = config.openaiBaseUrl.trim() || DEFAULT_OPENAI_BASE_URL;
  const model = config.openaiModel.trim() || DEFAULT_HELPER_MODEL;
  const endpoint = resolveResponsesEndpoint(baseUrl);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: prompt }],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new CodexHelperError(
      `${purposeLabel}请求失败，请检查 Codex 网关是否可用`,
      502,
    );
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const upstreamMessage = extractErrorMessage(payload);
    throw new CodexHelperError(
      upstreamMessage || `${purposeLabel}失败，请稍后重试`,
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }

  const text = extractOutputText(payload);
  if (!text) {
    throw new CodexHelperError(`${purposeLabel}未返回可解析内容`, 502);
  }

  let jsonStr = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonStr = fenced[1].trim();

  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    throw new CodexHelperError(`${purposeLabel}返回格式异常`, 502);
  }
}

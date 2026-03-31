import type {
  FollowUpMessage,
  RequestUserInputPrompt,
  RequestUserInputQuestion,
  RequestUserInputResponse,
} from './shared.js';

export function summarizeRequestUserInputPrompt(
  prompt: RequestUserInputPrompt,
): string {
  const question = prompt.question.trim();
  if (question) return question;
  if (prompt.header.trim()) return prompt.header.trim();
  return '等待用户补充输入';
}

export function buildRequestUserInputPrompts(
  requestId: string | number,
  itemId: string,
  questions: RequestUserInputQuestion[] | undefined,
): RequestUserInputPrompt[] {
  if (!questions) return [];
  const prompts: RequestUserInputPrompt[] = [];
  for (const [index, question] of questions.entries()) {
    const options: Array<{ label: string; description?: string }> = [];
    if (Array.isArray(question.options)) {
      for (const option of question.options) {
        options.push({
          label: option.label,
          description: option.description || undefined,
        });
      }
    }
    prompts.push({
      requestId: String(requestId),
      itemId,
      questionId:
        typeof question.id === 'string' && question.id.trim()
          ? question.id
          : `question-${itemId}-${index + 1}`,
      header: question.header,
      question: question.question,
      options,
      isOther: question.isOther,
      isSecret: question.isSecret,
    });
  }
  return prompts;
}

export function buildRequestUserInputToolPayload(
  prompts: RequestUserInputPrompt[],
): Record<string, unknown> {
  return {
    questions: prompts.map((prompt) => ({
      id: prompt.questionId,
      header: prompt.header,
      question: prompt.question,
      isOther: prompt.isOther,
      isSecret: prompt.isSecret,
      options: prompt.options.map((option) => ({
        label: option.label,
        value: option.label,
        description: option.description,
      })),
    })),
  };
}

export function assertSupportedRequestUserInputPrompts(
  prompts: RequestUserInputPrompt[],
): void {
  if (prompts.length <= 1) {
    return;
  }

  throw new Error(
    `当前交互提示包含 ${prompts.length} 个问题，HappyPaw 当前仅支持单题文本回答，无法构造 Codex 要求的 answers 映射。`,
  );
}

export function buildRequestUserInputAnswer(
  prompts: RequestUserInputPrompt[],
  message: Pick<FollowUpMessage, 'text' | 'images'>,
): RequestUserInputResponse {
  assertSupportedRequestUserInputPrompts(prompts);

  if (message.images && message.images.length > 0) {
    throw new Error('当前交互提示暂不支持图片回复，请仅发送文本答案。');
  }

  const answerText = message.text.trim();
  if (!answerText) {
    throw new Error('请输入回答内容后再继续。');
  }

  const answers: RequestUserInputResponse['answers'] = {};
  for (const prompt of prompts) {
    answers[prompt.questionId] = { answers: [answerText] };
  }
  return { answers };
}

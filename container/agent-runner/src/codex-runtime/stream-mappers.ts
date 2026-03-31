import { summarizeToolInput } from '../utils.js';
import type { ContainerInput, ContainerOutput } from '../types.js';
import type {
  CodexMcpServerStatus,
  CodexTodo,
  ReasoningItemState,
} from './shared.js';

export const OUTPUT_MARKER_TURN_ID_PREFIX = 'codex-turn-';

export const TURN_TERMINAL_IGNORED_METHODS = new Set([
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

export function mapCodexToolName(server: string, tool: string): string {
  if (server === 'happypaw') {
    return `mcp__happypaw__${tool}`;
  }
  return `${server}:${tool}`;
}

export function isNotificationForTurn(
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

export function buildPlanTodosFromUpdate(
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

export function normalizeTokenUsage(tokenUsage: Record<string, unknown>): {
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

export function normalizeMcpServerStatus(
  value: unknown,
): CodexMcpServerStatus | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) return null;

  const tools =
    record.tools && typeof record.tools === 'object'
      ? Object.keys(record.tools as Record<string, unknown>).sort()
      : [];

  return {
    name,
    authStatus:
      typeof record.authStatus === 'string' ? record.authStatus : undefined,
    tools,
  };
}

export function emitCodexStatus(
  emit: (output: ContainerOutput) => void,
  containerInput: ContainerInput,
  sessionId: string | undefined,
  statusText: string,
): void {
  emitCodexStreamEvent(emit, containerInput, sessionId, {
    status: 'stream',
    result: null,
    streamEvent: {
      eventType: 'status',
      statusText,
    },
  });
}

export function emitCodexStreamEvent(
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

export function emitCodexToolLifecycle(
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

export function emitCodexToolCompletion(
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

export function getReasoningItemState(
  reasoningItems: Map<string, ReasoningItemState>,
  itemId: string,
): ReasoningItemState {
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
}

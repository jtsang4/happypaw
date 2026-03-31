import type { ContainerInput, ContainerOutput } from './types.js';
import {
  CodexAppServerClient,
  type CodexJsonRpcNotification,
  type CodexJsonRpcRequest,
} from './codex-client.js';
import {
  buildUserInput,
  stageInputImages,
} from './codex-runtime/input-images.js';
import { verifyInternalMcpBridgeHealth } from './codex-runtime/mcp-health.js';
import { buildRuntimePromptContext } from './codex-runtime/prompt-context.js';
import {
  assertSupportedRequestUserInputPrompts,
  buildRequestUserInputAnswer,
  buildRequestUserInputPrompts,
  buildRequestUserInputToolPayload,
  summarizeRequestUserInputPrompt,
} from './codex-runtime/request-user-input.js';
import type {
  CodexTodo,
  ReasoningItemState,
  RequestUserInputPrompt,
  RuntimeDeps,
  StreamResult,
  ThreadResumeResult,
  ThreadStartResult,
  TurnStartResult,
} from './codex-runtime/shared.js';
import {
  emitCodexStreamEvent,
  emitCodexToolCompletion,
  emitCodexToolLifecycle,
  getReasoningItemState,
  buildPlanTodosFromUpdate,
  isNotificationForTurn,
  normalizeTokenUsage,
  OUTPUT_MARKER_TURN_ID_PREFIX,
  TURN_TERMINAL_IGNORED_METHODS,
} from './codex-runtime/stream-mappers.js';
import {
  combineQueuedMessages,
  shouldTreatFollowUpAsRebindBoundary,
  waitForTurnCompletion,
} from './codex-runtime/turn-monitor.js';

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

  const stagedImages = stageInputImages(
    deps.WORKSPACE_GROUP,
    images,
    detectImageMimeTypeFromBase64Strict,
    deps.log,
  );
  const initialInput = buildUserInput(
    prompt,
    images,
    detectImageMimeTypeFromBase64Strict,
    deps.log,
    stagedImages.paths,
  );
  for (const reason of [...stagedImages.rejected, ...initialInput.rejected]) {
    emit({
      status: 'success',
      result: `⚠️ ${reason}`,
    });
  }

  const userInput = initialInput.input;

  let clientDiedUnexpectedly = false;
  const createClient = (): CodexAppServerClient =>
    new CodexAppServerClient({
      env: {
        ...process.env,
        CODEX_HOME: process.env.CODEX_HOME,
      },
      log: deps.log,
      onNotification: () => {},
      onRequest: () => {
        throw new Error(
          'Unexpected JSON-RPC request before Codex runtime initialized',
        );
      },
    });
  let client =
    deps.getPersistentClient?.() && !deps.getPersistentClient?.()?.isClosed()
      ? deps.getPersistentClient?.()
      : undefined;
  const ownsEphemeralClient = !client;
  if (!client) {
    client = createClient();
    deps.setPersistentClient?.(client);
  }

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
    sessionId?: string;
    chatJid?: string;
    replyRouteJid?: string;
  }> = [];
  const stagedImageCleanupFns: Array<() => void> = [stagedImages.cleanup];
  let activeUserInputRequest:
    | {
        requestId: string;
        itemId: string;
        prompts: RequestUserInputPrompt[];
      }
    | undefined;
  const startupWarnings: string[] = [];
  let clientExitMessage: string | undefined;

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

  const emitReasoningSummarySnapshot = (
    item: Record<string, unknown>,
  ): void => {
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
    client.setExitHandler((error) => {
      clientExitMessage = error.message;
      turnComplete = {
        status: 'failed',
        turn: {
          error: {
            message: error.message,
          },
        },
      };
    });

    const notificationHandler = (
      notification: CodexJsonRpcNotification,
    ): void => {
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
        case 'configWarning': {
          const summary =
            typeof params?.summary === 'string' ? params.summary.trim() : '';
          const details =
            typeof params?.details === 'string' ? params.details.trim() : '';
          const warningText = [summary, details].filter(Boolean).join(' — ');
          if (warningText) {
            startupWarnings.push(warningText);
            deps.log(`[codex-config-warning] ${warningText}`);
          }
          break;
        }
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
          if (typeof params?.turnId === 'string' && params.turnId === turnId) {
            emit({
              status: 'stream',
              result: null,
              newSessionId: currentSessionId,
              streamEvent: {
                eventType: 'tool_progress',
                toolUseId:
                  typeof params.itemId === 'string' ? params.itemId : undefined,
                text:
                  typeof params.message === 'string'
                    ? params.message
                    : undefined,
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
            if (!finalText && Array.isArray(turn.items)) {
              finalText = (turn.items as Array<Record<string, unknown>>)
                .filter((item) => item.type === 'agentMessage')
                .map((item) => (typeof item.text === 'string' ? item.text : ''))
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
    client.setRequestHandler(async (request: CodexJsonRpcRequest) => {
      if (request.method !== 'item/tool/requestUserInput') {
        throw new Error(`Unsupported Codex request: ${request.method}`);
      }

      const params = request.params;
      const requestTurnId = params.turnId;
      if (turnId && requestTurnId && requestTurnId !== turnId) {
        throw new Error('request_user_input turnId did not match active turn');
      }
      const itemId = params.itemId || `request-${request.id}`;
      const prompts = buildRequestUserInputPrompts(
        request.id,
        itemId,
        params.questions,
      );
      if (prompts.length === 0) {
        throw new Error('request_user_input missing questions');
      }
      emit({
        status: 'stream',
        result: null,
        newSessionId: currentSessionId,
        streamEvent: {
          eventType: 'tool_use_start',
          toolName: 'AskUserQuestion',
          toolUseId: itemId,
          toolInputSummary: summarizeRequestUserInputPrompt(prompts[0]),
          toolInput: buildRequestUserInputToolPayload(prompts),
        },
      });
      emit({
        status: 'stream',
        result: null,
        newSessionId: currentSessionId,
        streamEvent: {
          eventType: 'tool_progress',
          toolUseId: itemId,
          toolInput: buildRequestUserInputToolPayload(prompts),
        },
      });

      try {
        assertSupportedRequestUserInputPrompts(prompts);
      } catch (error) {
        emit({
          status: 'stream',
          result: null,
          newSessionId: currentSessionId,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: itemId,
          },
        });
        throw error;
      }

      activeUserInputRequest = {
        requestId: String(request.id),
        itemId,
        prompts,
      };

      let promptMessage:
        | {
            text: string;
            images?: Array<{ data: string; mimeType?: string }>;
          }
        | undefined;
      while (!promptMessage) {
        if (deps.shouldClose()) {
          activeUserInputRequest = undefined;
          throw new Error(
            'request_user_input closed before receiving user answer',
          );
        }
        if (deps.shouldInterrupt()) {
          activeUserInputRequest = undefined;
          throw new Error(
            'request_user_input interrupted before receiving user answer',
          );
        }
        const drained = deps.drainIpcInput().messages;
        if (drained.length > 0) {
          promptMessage = combineQueuedMessages(drained);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (!promptMessage) {
        activeUserInputRequest = undefined;
        throw new Error('request_user_input ended without collecting a reply');
      }
      const responsePayload = buildRequestUserInputAnswer(
        prompts,
        promptMessage,
      );
      emit({
        status: 'stream',
        result: null,
        newSessionId: currentSessionId,
        streamEvent: {
          eventType: 'tool_use_end',
          toolUseId: itemId,
        },
      });
      activeUserInputRequest = undefined;
      return responsePayload;
    });

    if (client.isClosed()) {
      throw new Error('codex app-server is not running');
    }

    if (client !== deps.getPersistentClient?.()) {
      deps.setPersistentClient?.(client);
    }

    if (!client.isInitialized()) {
      await client.initialize();
    }

    if (deps.shouldInterrupt()) {
      return {
        closedDuringQuery: false,
        interruptedDuringQuery: true,
        newSessionId: threadId,
      };
    }

    await verifyInternalMcpBridgeHealth({
      client,
      emit,
      containerInput,
      sessionId: currentSessionId,
      startupWarnings,
    });

    try {
      if (threadId) {
        const resumeResult: ThreadResumeResult = await client.request(
          'thread/resume',
          {
            threadId,
            cwd: deps.WORKSPACE_GROUP,
            approvalPolicy: 'never',
            persistExtendedHistory: false,
            baseInstructions: systemPromptAppend,
          },
        );
        threadId = resumeResult.thread.id || threadId;
      } else {
        const startResult: ThreadStartResult = await client.request(
          'thread/start',
          {
            cwd: deps.WORKSPACE_GROUP,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            baseInstructions: systemPromptAppend,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
          },
        );
        threadId = startResult.thread.id;
      }
      currentSessionId = threadId;
    } catch (error) {
      if (threadId) {
        deps.log(
          `thread/resume failed, falling back to fresh thread: ${String(error)}`,
        );
        const startResult: ThreadStartResult = await client.request(
          'thread/start',
          {
            cwd: deps.WORKSPACE_GROUP,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            baseInstructions: systemPromptAppend,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
          },
        );
        threadId = startResult.thread.id;
        currentSessionId = threadId;
      } else {
        throw error;
      }
    }

    const activeThreadId = threadId;
    const turnResult: TurnStartResult = await client.request('turn/start', {
      threadId: activeThreadId,
      input: userInput,
    });
    turnId = turnResult.turn.id;
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
      canSteer: () => !activeUserInputRequest,
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
        if (
          shouldTreatFollowUpAsRebindBoundary(message, {
            sessionId: currentSessionId,
            chatJid: containerInput.chatJid,
            replyRouteJid: containerInput.replyRouteJid,
          })
        ) {
          deps.log(
            'Deferring active-turn follow-up to next turn because session/chat/reply-route metadata changed',
          );
          deferredFollowUps.push(message);
          return;
        }
        const stagedSteerImages = stageInputImages(
          deps.WORKSPACE_GROUP,
          message.images,
          detectImageMimeTypeFromBase64Strict,
          deps.log,
        );
        stagedImageCleanupFns.push(stagedSteerImages.cleanup);
        const steerInput = buildUserInput(
          message.text,
          message.images,
          detectImageMimeTypeFromBase64Strict,
          deps.log,
          stagedSteerImages.paths,
        );
        for (const reason of [
          ...stagedSteerImages.rejected,
          ...steerInput.rejected,
        ]) {
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
        clientDiedUnexpectedly,
      };
    }
    if (monitorResult.state === 'interrupted') {
      return {
        closedDuringQuery: false,
        interruptedDuringQuery: true,
        newSessionId: currentSessionId,
        followUpInput: combineQueuedMessages(deferredFollowUps),
        clientDiedUnexpectedly,
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
        clientDiedUnexpectedly,
      };
    }
    if (turnComplete.status === 'failed') {
      const message =
        clientExitMessage ||
        latestErrorMessage ||
        (turnComplete.turn?.error as { message?: string } | undefined)
          ?.message ||
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
      clientDiedUnexpectedly,
    };
  } catch (error) {
    if (client.isClosed()) {
      clientDiedUnexpectedly = true;
      deps.setPersistentClient?.(undefined);
    }
    throw error;
  } finally {
    if (
      ownsEphemeralClient &&
      !deps.getPersistentClient &&
      !client.isClosed()
    ) {
      await client.close();
    }
    client.setExitHandler(null);
    for (const cleanup of stagedImageCleanupFns.splice(0)) {
      cleanup();
    }
  }
}

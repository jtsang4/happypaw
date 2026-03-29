import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../../../../../logger.js';
import {
  CARD_MD_LIMIT,
  CARD_SIZE_LIMIT,
  ELEMENT_IDS,
  MAX_COMPLETED_TOOL_AGE,
  MAX_RECENT_EVENTS,
  MAX_THINKING_CHARS,
  buildAuxiliaryElements,
  buildSchema2Card,
  buildStreamingCard,
  buildStreamingModeCard,
  extractTitleAndBody,
  formatUsageNote,
  serializeAuxContent,
  splitCodeBlockSafe,
  type AuxiliaryState,
  type ToolCallState,
  type StreamingCardOptions,
  type StreamingState,
} from './helpers.js';
import {
  CardKitBackend,
  FlushController,
  MultiCardManager,
  StreamingModeBackend,
} from './backends.js';

export class StreamingCardController {
  private state: StreamingState = 'idle';
  private messageId: string | null = null;
  private accumulatedText = '';
  private flushCtrl: FlushController;
  private patchFailCount = 0;
  private maxPatchFailures = 2;
  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly onFallback?: () => void;
  private readonly onCardCreated?: (messageId: string) => void;

  // CardKit mode
  private useCardKit = false;
  private multiCard: MultiCardManager | null = null;

  // Streaming mode (Level 0)
  private streamingBackend: StreamingModeBackend | null = null;
  private textFlushCtrl: FlushController | null = null;
  private auxFlushCtrl: FlushController | null = null;
  private lastAuxSnapshot = '';

  // Streaming state
  private thinking = false;
  private thinkingText = '';
  private toolCalls = new Map<string, ToolCallState>();
  private startTime = 0;
  private backendMode: 'streaming' | 'v1' | 'legacy' = 'v1';

  // Auxiliary display state
  private systemStatus: string | null = null;
  private activeHook: { hookName: string; hookEvent: string } | null = null;
  private todos: Array<{ id: string; content: string; status: string }> | null =
    null;
  private recentEvents: Array<{ text: string }> = [];
  private stateVersion = 0;

  constructor(opts: StreamingCardOptions) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
    this.onFallback = opts.onFallback;
    this.onCardCreated = opts.onCardCreated;
    this.flushCtrl = new FlushController();
  }

  get currentState(): StreamingState {
    return this.state;
  }

  get currentMessageId(): string | null {
    if (this.streamingBackend) return this.streamingBackend.messageId;
    if (this.multiCard) return this.multiCard.getLatestMessageId();
    return this.messageId;
  }

  isActive(): boolean {
    return this.state === 'streaming' || this.state === 'creating';
  }

  /**
   * Get all messageIds across all cards (for multi-card cleanup).
   */
  getAllMessageIds(): string[] {
    if (this.streamingBackend?.messageId)
      return [this.streamingBackend.messageId];
    if (this.multiCard) return this.multiCard.getAllMessageIds();
    return this.messageId ? [this.messageId] : [];
  }

  /**
   * Signal that the agent is in thinking state (before text arrives).
   */
  setThinking(): void {
    this.thinking = true;
    if (this.state === 'idle') {
      // Create card immediately with thinking placeholder
      this.state = 'creating';
      this.createInitialCard().catch((err) => {
        logger.warn(
          { err, chatId: this.chatId },
          'Streaming card: initial create failed (thinking), will use fallback',
        );
        this.state = 'error';
        this.onFallback?.();
      });
    }
  }

  /**
   * Signal that a tool has started executing.
   */
  startTool(toolId: string, toolName: string): void {
    this.toolCalls.set(toolId, {
      name: toolName,
      status: 'running',
      startTime: Date.now(),
    });
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Signal that a tool has finished executing.
   */
  endTool(toolId: string, isError: boolean): void {
    const tc = this.toolCalls.get(toolId);
    if (tc) {
      tc.status = isError ? 'error' : 'complete';
      this.stateVersion++;
      this.purgeOldTools();
      if (this.state === 'streaming') {
        this.backendMode === 'streaming'
          ? this.scheduleAuxFlush()
          : this.schedulePatch();
      }
    }
  }

  /**
   * Purge completed/error tools older than MAX_COMPLETED_TOOL_AGE to prevent unbounded growth.
   */
  private purgeOldTools(): void {
    const cutoff = Date.now() - MAX_COMPLETED_TOOL_AGE;
    for (const [id, tc] of this.toolCalls) {
      if (tc.status !== 'running' && tc.startTime < cutoff) {
        this.toolCalls.delete(id);
      }
    }
  }

  /**
   * Append thinking text (accumulated, tail-truncated at MAX_THINKING_CHARS).
   */
  appendThinking(text: string): void {
    this.thinkingText += text;
    if (this.thinkingText.length > MAX_THINKING_CHARS) {
      this.thinkingText =
        '...' + this.thinkingText.slice(-(MAX_THINKING_CHARS - 3));
    }
    this.thinking = true;
    this.stateVersion++;
    if (this.state === 'idle') {
      this.state = 'creating';
      this.createInitialCard().catch((err) => {
        logger.warn(
          { err, chatId: this.chatId },
          'Streaming card: initial create failed (thinking), will use fallback',
        );
        this.state = 'error';
        this.onFallback?.();
      });
    } else if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Set or clear system status text (e.g. "上下文压缩中").
   */
  setSystemStatus(status: string | null): void {
    this.systemStatus = status;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Set or clear active hook state.
   */
  setHook(hook: { hookName: string; hookEvent: string } | null): void {
    this.activeHook = hook;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Set the todo list for progress panel display.
   */
  setTodos(
    todos: Array<{ id: string; content: string; status: string }>,
  ): void {
    this.todos = todos;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Push a recent event to the call trace log (FIFO, max MAX_RECENT_EVENTS).
   * Does NOT trigger schedulePatch — piggybacks on other events.
   */
  pushRecentEvent(text: string): void {
    this.recentEvents.push({ text });
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents = this.recentEvents.slice(-MAX_RECENT_EVENTS);
    }
  }

  /**
   * Update a tool's input summary (displayed as parameter hint).
   */
  updateToolSummary(toolId: string, summary: string): void {
    const tc = this.toolCalls.get(toolId);
    if (tc) {
      tc.toolInputSummary = summary;
      this.stateVersion++;
      if (this.state === 'streaming') {
        this.backendMode === 'streaming'
          ? this.scheduleAuxFlush()
          : this.schedulePatch();
      }
    }
  }

  /**
   * Get tool info by ID (for building call trace text).
   */
  getToolInfo(toolId: string): { name: string } | undefined {
    const tc = this.toolCalls.get(toolId);
    return tc ? { name: tc.name } : undefined;
  }

  /**
   * Append text to the streaming card.
   * Creates the card on first call, then patches on subsequent calls.
   */
  append(text: string): void {
    this.accumulatedText = text;
    this.thinking = false; // Text arrived, no longer just thinking
    this.thinkingText = ''; // Clear thinking text once real text arrives

    if (this.state === 'idle') {
      this.state = 'creating';
      this.createInitialCard().catch((err) => {
        logger.warn(
          { err, chatId: this.chatId },
          'Streaming card: initial create failed, will use fallback',
        );
        this.state = 'error';
        this.onFallback?.();
      });
      return;
    }

    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleTextFlush()
        : this.schedulePatch();
    }
    // If 'creating', the text will be picked up after creation completes
  }

  /**
   * Complete the streaming card with final text.
   */
  async complete(finalText: string): Promise<void> {
    if (this.state !== 'streaming' && this.state !== 'creating') return;

    const prevState = this.state;
    this.accumulatedText = finalText;
    this.state = 'completed';
    this.flushCtrl.dispose();
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();

    try {
      if (this.backendMode === 'streaming' && this.streamingBackend) {
        await this.finalizeStreamingCard('completed');
      } else if (this.messageId || this.multiCard) {
        await this.patchCard('completed');
      }
    } catch (err) {
      // Revert state so abort() doesn't bail on the 'completed' check
      this.state = prevState;
      throw err;
    }
  }

  /**
   * Patch a completed card to append a usage note at the bottom.
   * Called AFTER complete() because agent-runner emits usage after the final result.
   */
  async patchUsageNote(usage: {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
  }): Promise<void> {
    if (this.state !== 'completed') return;

    const note = formatUsageNote(usage);
    if (!note) return;

    try {
      if (this.backendMode === 'streaming' && this.streamingBackend) {
        const cardJson = buildSchema2Card(
          this.accumulatedText,
          'completed',
          '',
          undefined,
          undefined,
          note,
        );
        // Skip if card was split during finalization — rebuilding a single card
        // would overwrite the first card with full text while continuation cards remain.
        const cardSize = Buffer.byteLength(JSON.stringify(cardJson), 'utf-8');
        if (cardSize > CARD_SIZE_LIMIT) return;
        await this.streamingBackend.updateCardFull(cardJson);
      } else if (this.messageId || this.multiCard) {
        // For CardKit v1 / legacy: skip if multiCard has split content
        if (this.multiCard && this.multiCard.getCardCount() > 1) return;
        await this.patchCard('completed', note);
      }
    } catch (err) {
      logger.debug(
        { err, chatId: this.chatId },
        'Streaming card: patchUsageNote failed (non-fatal)',
      );
    }
  }

  /**
   * Abort the streaming card (e.g., user interrupted).
   */
  async abort(reason?: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;

    const wasActive = this.isActive();
    this.state = 'aborted';
    this.flushCtrl.dispose();
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();

    if (reason) {
      this.accumulatedText += `\n\n---\n*${reason}*`;
    }

    if (
      this.backendMode === 'streaming' &&
      this.streamingBackend &&
      wasActive
    ) {
      try {
        await this.finalizeStreamingCard('aborted');
      } catch (err) {
        logger.debug(
          { err, chatId: this.chatId },
          'Streaming card: abort finalize failed',
        );
      }
    } else if ((this.messageId || this.multiCard) && wasActive) {
      try {
        await this.patchCard('aborted');
      } catch (err) {
        logger.debug(
          { err, chatId: this.chatId },
          'Streaming card: abort patch failed',
        );
      }
    }
  }

  dispose(): void {
    this.flushCtrl.dispose();
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();
  }

  // ─── Internal Methods ──────────────────────────────────

  private async createInitialCard(): Promise<void> {
    const initialText = this.accumulatedText || (this.thinking ? '' : '...');

    // ── Level 0: Try streaming mode (cardElement.content typewriter) ──
    try {
      const backend = new StreamingModeBackend(this.client);
      const cardJson = buildStreamingModeCard(initialText);
      await backend.createCard(cardJson);
      const messageId = await backend.sendCard(this.chatId, this.replyToMsgId);

      this.streamingBackend = backend;
      this.messageId = messageId;
      this.backendMode = 'streaming';
      this.useCardKit = true;
      this.startTime = Date.now();
      // Streaming mode: 300ms text flush, 800ms aux flush
      this.textFlushCtrl = new FlushController(300, 30);
      this.auxFlushCtrl = new FlushController(800, 0);
      this.maxPatchFailures = 3;

      logger.debug(
        { chatId: this.chatId, messageId, mode: 'streaming' },
        'Streaming card created via streaming mode',
      );

      this.finishCardCreation();
      return;
    } catch (streamingErr) {
      logger.info(
        { err: streamingErr, chatId: this.chatId },
        'Streaming mode unavailable, falling back to CardKit v1',
      );
      this.streamingBackend = null;
    }

    // ── Level 1: Try CardKit v1 full-update (card.update with full JSON) ──
    try {
      this.multiCard = new MultiCardManager(
        this.client,
        this.chatId,
        this.replyToMsgId,
        this.onCardCreated,
      );
      const messageId = await this.multiCard.initialize(initialText);

      this.messageId = messageId;
      this.backendMode = 'v1';
      this.useCardKit = true;
      this.startTime = Date.now();
      // CardKit v1 mode: 1000ms interval, bump failure tolerance
      this.flushCtrl.dispose();
      this.flushCtrl = new FlushController(1000, 50);
      this.maxPatchFailures = 3;

      logger.debug(
        { chatId: this.chatId, messageId, mode: 'cardkit-v1' },
        'Streaming card created via CardKit v1',
      );
    } catch (v1Err) {
      // ── Level 2: Legacy message.create + message.patch ──
      logger.info(
        { err: v1Err, chatId: this.chatId },
        'CardKit full-update unavailable, falling back to message.patch',
      );
      this.multiCard = null;
      this.useCardKit = false;
      this.backendMode = 'legacy';
      this.startTime = Date.now();

      await this.createLegacyCard(initialText);
      return;
    }

    // Handle state changes during await (same logic for both paths)
    this.finishCardCreation();
  }

  private async createLegacyCard(initialText: string): Promise<void> {
    const card = buildStreamingCard(initialText, 'streaming');
    const content = JSON.stringify(card);

    try {
      let resp: any;

      if (this.replyToMsgId) {
        resp = await this.client.im.message.reply({
          path: { message_id: this.replyToMsgId },
          data: { content, msg_type: 'interactive' },
        });
      } else {
        resp = await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: this.chatId,
            msg_type: 'interactive',
            content,
          },
        });
      }

      this.messageId = resp?.data?.message_id || null;
      if (!this.messageId) {
        throw new Error('No message_id in response');
      }

      logger.debug(
        { chatId: this.chatId, messageId: this.messageId, mode: 'legacy' },
        'Streaming card created via legacy path',
      );

      this.finishCardCreation();
    } catch (err) {
      this.state = 'error';
      throw err;
    }
  }

  private finishCardCreation(): void {
    // Check if state changed while we were awaiting the API call.
    if (this.state !== 'creating') {
      const finalState = this.state as 'completed' | 'aborted';
      logger.debug(
        { chatId: this.chatId, messageId: this.messageId, finalState },
        'Streaming card created but state already changed, patching to final',
      );
      if (this.backendMode === 'streaming' && this.streamingBackend) {
        this.finalizeStreamingCard(finalState).catch((err) => {
          logger.debug(
            { err, chatId: this.chatId },
            'Failed to finalize streaming card after late creation',
          );
        });
      } else {
        this.patchCard(finalState).catch((err) => {
          logger.debug(
            { err, chatId: this.chatId },
            'Failed to patch to final state after late creation',
          );
        });
      }
      return;
    }

    this.state = 'streaming';
    if (this.messageId) {
      this.onCardCreated?.(this.messageId);
    }

    // If text accumulated while creating, schedule a flush/patch
    if (this.accumulatedText.length > 3) {
      this.backendMode === 'streaming'
        ? this.scheduleTextFlush()
        : this.schedulePatch();
    }
  }

  private schedulePatch(): void {
    if (this.patchFailCount >= this.maxPatchFailures) {
      logger.info(
        { chatId: this.chatId, useCardKit: this.useCardKit },
        'Streaming card: too many patch failures, falling back',
      );
      this.state = 'error';
      this.flushCtrl.dispose();
      this.onFallback?.();
      return;
    }

    // Use effectiveLength so FlushController detects non-text state changes
    // (thinking, tool status, system status, etc.)
    const effectiveLength =
      this.accumulatedText.length + this.stateVersion * 1000;
    this.flushCtrl.schedule(effectiveLength, async () => {
      await this.patchCard('streaming');
    });
  }

  private getAuxiliaryState(): AuxiliaryState {
    return {
      thinkingText: this.thinkingText,
      isThinking: this.thinking,
      toolCalls: this.toolCalls,
      systemStatus: this.systemStatus,
      activeHook: this.activeHook,
      todos: this.todos,
      recentEvents: this.recentEvents,
    };
  }

  // ─── Streaming Mode Methods ──────────────────────────────

  /**
   * Schedule a text content flush for streaming mode.
   * Falls back to schedulePatch() if streaming backend is not available.
   */
  private scheduleTextFlush(): void {
    if (!this.streamingBackend || !this.textFlushCtrl) {
      this.schedulePatch();
      return;
    }

    this.textFlushCtrl.schedule(this.accumulatedText.length, async () => {
      try {
        await this.streamingBackend!.streamContent(this.accumulatedText);
        this.textFlushCtrl!.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          {
            err,
            chatId: this.chatId,
            failCount: this.patchFailCount,
            mode: 'streaming',
          },
          'Streaming content push failed',
        );
        if (this.patchFailCount >= this.maxPatchFailures) {
          this.degradeToV1();
        }
      }
    });
  }

  /**
   * Schedule an auxiliary content flush for streaming mode.
   * Falls back to schedulePatch() if streaming backend is not available.
   */
  private scheduleAuxFlush(): void {
    if (!this.streamingBackend || !this.auxFlushCtrl) {
      this.schedulePatch();
      return;
    }

    this.auxFlushCtrl.schedule(this.stateVersion * 1000, async () => {
      // Recalculate aux state inside callback to avoid stale closures
      const auxState = this.getAuxiliaryState();
      const { before, after } = buildAuxiliaryElements(auxState);
      const auxBefore = serializeAuxContent(before);
      const auxAfter = serializeAuxContent(after);
      const snapshot = auxBefore + '||' + auxAfter;
      if (snapshot === this.lastAuxSnapshot) return;

      try {
        await this.streamingBackend!.updateAuxiliary(
          ELEMENT_IDS.AUX_BEFORE,
          auxBefore,
        );
        await this.streamingBackend!.updateAuxiliary(
          ELEMENT_IDS.AUX_AFTER,
          auxAfter,
        );
        this.lastAuxSnapshot = snapshot;
      } catch (err) {
        // Auxiliary update failures do NOT count toward degradation
        logger.debug(
          { err, chatId: this.chatId, mode: 'streaming' },
          'Streaming auxiliary update failed (non-critical)',
        );
      }
    });
  }

  /**
   * Degrade from streaming mode to v1 full-update mode.
   */
  private degradeToV1(): void {
    logger.warn(
      { chatId: this.chatId },
      'Streaming mode: degrading to v1 full-update',
    );

    // Save card_id and sequence from streaming backend before clearing
    const existingCardId = this.streamingBackend!.getCardId();
    const existingSeq = this.streamingBackend!.getSequence();

    // Try to disable streaming mode gracefully (fire and forget)
    this.streamingBackend?.disableStreamingMode().catch(() => {});

    this.backendMode = 'v1';
    this.streamingBackend = null;
    this.textFlushCtrl?.dispose();
    this.textFlushCtrl = null;
    this.auxFlushCtrl?.dispose();
    this.auxFlushCtrl = null;
    this.patchFailCount = 0;

    // Set up v1 flush controller
    this.flushCtrl.dispose();
    this.flushCtrl = new FlushController(1000, 50);

    // Adopt the existing streaming card into a CardKitBackend (reuses card_id, no new message)
    const adoptedCard = new CardKitBackend(this.client);
    adoptedCard.adoptCard(existingCardId!, this.messageId!, existingSeq);

    this.multiCard = new MultiCardManager(
      this.client,
      this.chatId,
      this.replyToMsgId,
      this.onCardCreated,
    );
    this.multiCard.adoptExistingCard(adoptedCard);

    // Schedule an immediate patch to sync the current state
    this.schedulePatch();
  }

  /**
   * Finalize a streaming card: disable streaming mode, then set final state.
   */
  private async finalizeStreamingCard(
    finalState: 'completed' | 'aborted',
  ): Promise<void> {
    const backend = this.streamingBackend!;

    try {
      // 1. Disable streaming mode (allows header/button changes)
      await backend.disableStreamingMode();

      // 2. Build final card with optimizeMarkdownStyle
      const cardJson = buildSchema2Card(this.accumulatedText, finalState);
      const cardSize = Buffer.byteLength(JSON.stringify(cardJson), 'utf-8');

      if (cardSize <= CARD_SIZE_LIMIT) {
        // 3a. Single card fits
        await backend.updateCardFull(cardJson);
      } else {
        // 3b. Too large for single card — split on finalize
        await this.splitOnFinalize(finalState);
      }
    } catch (err) {
      logger.debug(
        { err, chatId: this.chatId },
        'Streaming finalize failed, trying truncated fallback',
      );
      // Fallback: truncate and try once more
      try {
        const truncated = this.accumulatedText.slice(0, 20000);
        const fallbackCard = buildSchema2Card(
          truncated + '\n\n> ⚠️ 输出已截断',
          finalState,
        );
        await backend.updateCardFull(fallbackCard);
      } catch (fallbackErr) {
        logger.debug(
          { err: fallbackErr, chatId: this.chatId },
          'Streaming finalize truncated fallback also failed',
        );
      }
    }
  }

  /**
   * Split content into multiple cards on finalize (only when streaming card content exceeds CARD_SIZE_LIMIT).
   * The first card (existing streaming card) gets frozen, subsequent cards are new.
   */
  private async splitOnFinalize(
    finalState: 'completed' | 'aborted',
  ): Promise<void> {
    const backend = this.streamingBackend!;
    const { title } = extractTitleAndBody(this.accumulatedText);
    const chunks = splitCodeBlockSafe(this.accumulatedText, CARD_MD_LIMIT);

    // How many chunks fit in the first card?
    const MAX_ELEMENTS_PER_CARD = 45;
    const fixedElements = 2; // note + margin
    const maxChunksFirst = MAX_ELEMENTS_PER_CARD - fixedElements;

    const firstChunks = chunks.slice(0, maxChunksFirst);
    const firstText = firstChunks.join('\n\n');

    // Use finalState if all content fits in the first card, otherwise freeze
    const firstCardState =
      chunks.length <= maxChunksFirst ? finalState : 'frozen';
    const frozenCard = buildSchema2Card(firstText, firstCardState, '', title);
    await backend.updateCardFull(frozenCard);

    // Create continuation cards
    let remaining = chunks.slice(maxChunksFirst);
    while (remaining.length > 0) {
      const batch = remaining.slice(0, maxChunksFirst);
      remaining = remaining.slice(maxChunksFirst);
      const batchText = batch.join('\n\n');
      const state = remaining.length === 0 ? finalState : 'frozen';
      const contCard = new CardKitBackend(this.client);
      const contCardJson = buildSchema2Card(batchText, state, '(续) ', title);
      await contCard.createCard(contCardJson);
      const newMsgId = await contCard.sendCard(this.chatId);
      this.onCardCreated?.(newMsgId);
    }
  }

  private async patchCard(
    displayState: 'streaming' | 'completed' | 'aborted',
    footerNote?: string,
  ): Promise<void> {
    if (this.useCardKit && this.multiCard) {
      // CardKit v1 path — pass auxiliary state for rich display
      const auxState =
        displayState === 'streaming' ? this.getAuxiliaryState() : undefined;
      try {
        await this.multiCard.commitContent(
          this.accumulatedText,
          displayState,
          auxState,
          footerNote,
        );
        this.flushCtrl.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          {
            err,
            chatId: this.chatId,
            failCount: this.patchFailCount,
            mode: 'cardkit',
          },
          'CardKit card update failed',
        );
        throw err;
      }
    } else {
      // Legacy message.patch path (no auxiliary content)
      if (!this.messageId) return;

      const card = buildStreamingCard(
        this.accumulatedText,
        displayState,
        footerNote,
      );
      const content = JSON.stringify(card);

      try {
        await this.client.im.v1.message.patch({
          path: { message_id: this.messageId },
          data: { content },
        });
        this.flushCtrl.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          {
            err,
            chatId: this.chatId,
            failCount: this.patchFailCount,
            mode: 'legacy',
          },
          'Streaming card patch failed',
        );
        throw err;
      }
    }
  }
}

import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'crypto';
import { logger } from '../../../../../logger.js';
import type { AuxiliaryState } from './helpers.js';
import {
  CARD_MD_LIMIT,
  CARD_SIZE_LIMIT,
  ELEMENT_IDS,
  MAX_STREAMING_CONTENT,
  SCHEMA2_NOTE_MAP,
  STREAMING_CONFIG,
  buildAuxiliaryElements,
  buildCardContent,
  buildSchema2Card,
  extractTitleAndBody,
  splitCodeBlockSafe,
} from './helpers.js';

// ─── Flush Controller ─────────────────────────────────────────

export class FlushController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = 0;
  private lastFlushedLength = 0;
  private pendingFlush: (() => Promise<void>) | null = null;

  /** Minimum interval between flushes (ms) */
  private readonly minInterval: number;
  /** Minimum text change to trigger a flush (chars) */
  private readonly minDelta: number;

  constructor(minInterval = 1200, minDelta = 50) {
    this.minInterval = minInterval;
    this.minDelta = minDelta;
  }

  /**
   * Schedule a flush. If a flush is already pending, replace it.
   * The flush function will be called after the minimum interval.
   */
  schedule(currentLength: number, flushFn: () => Promise<void>): void {
    // Check text change threshold
    if (currentLength - this.lastFlushedLength < this.minDelta) {
      // Still schedule in case no more text comes (ensure eventual flush)
      if (!this.timer) {
        this.pendingFlush = flushFn;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.executeFlush();
        }, this.minInterval);
      } else {
        this.pendingFlush = flushFn;
      }
      return;
    }

    // Enough text change — schedule or execute
    this.pendingFlush = flushFn;
    const elapsed = Date.now() - this.lastFlushTime;
    if (elapsed >= this.minInterval) {
      // Can flush immediately
      this.clearTimer();
      this.executeFlush();
    } else if (!this.timer) {
      // Schedule for remaining interval
      this.timer = setTimeout(() => {
        this.timer = null;
        this.executeFlush();
      }, this.minInterval - elapsed);
    }
    // else: timer already running, will pick up pendingFlush
  }

  /** Force flush immediately (for complete/abort) */
  async forceFlush(flushFn: () => Promise<void>): Promise<void> {
    this.clearTimer();
    this.pendingFlush = flushFn;
    await this.executeFlush();
  }

  private async executeFlush(): Promise<void> {
    const fn = this.pendingFlush;
    this.pendingFlush = null;
    if (!fn) return;
    this.lastFlushTime = Date.now();
    try {
      await fn();
    } catch (err) {
      logger.debug({ err }, 'FlushController: flush failed');
    }
  }

  markFlushed(length: number): void {
    this.lastFlushedLength = length;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.clearTimer();
    this.pendingFlush = null;
  }
}

// ─── CardKit Backend ──────────────────────────────────────────

function quickHash(data: string): string {
  return createHash('md5').update(data).digest('hex');
}

export class CardKitBackend {
  private cardId: string | null = null;
  private _messageId: string | null = null;
  private sequence = 0;
  private lastContentHash = '';
  private readonly client: lark.Client;

  constructor(client: lark.Client) {
    this.client = client;
  }

  get messageId(): string | null {
    return this._messageId;
  }

  /**
   * Create a CardKit card instance.
   * Returns the card_id for subsequent updates.
   */
  async createCard(cardJson: object): Promise<string> {
    const resp = await this.client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardJson),
      },
    });

    const cardId = resp?.data?.card_id;
    if (!cardId) {
      const code = (resp as any)?.code;
      const msg = (resp as any)?.msg;
      throw new Error(
        `CardKit card.create returned no card_id (code=${code}, msg=${msg})`,
      );
    }

    this.cardId = cardId;
    this.sequence = 1;
    this.lastContentHash = quickHash(JSON.stringify(cardJson));
    logger.debug({ cardId }, 'CardKit card created');
    return cardId;
  }

  /**
   * Send the card as a message (referencing card_id).
   * Returns the message_id.
   */
  async sendCard(chatId: string, replyToMsgId?: string): Promise<string> {
    if (!this.cardId) {
      throw new Error('Cannot sendCard before createCard');
    }

    const content = JSON.stringify({
      type: 'card',
      data: { card_id: this.cardId },
    });

    let resp: any;
    if (replyToMsgId) {
      resp = await this.client.im.message.reply({
        path: { message_id: replyToMsgId },
        data: { content, msg_type: 'interactive' },
      });
    } else {
      resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content,
        },
      });
    }

    const messageId = resp?.data?.message_id;
    if (!messageId) {
      throw new Error('No message_id in sendCard response');
    }

    this._messageId = messageId;
    return messageId;
  }

  /**
   * Update the card via CardKit card.update with sequence-based optimistic locking.
   * Skips if content hash is unchanged.
   */
  async updateCard(cardJson: object): Promise<void> {
    if (!this.cardId) return;

    const dataStr = JSON.stringify(cardJson);
    const hash = quickHash(dataStr);
    if (hash === this.lastContentHash) return; // no change

    this.sequence++;
    await this.client.cardkit.v1.card.update({
      path: { card_id: this.cardId },
      data: {
        card: { type: 'card_json', data: dataStr },
        sequence: this.sequence,
      },
    });

    this.lastContentHash = hash;
  }

  /**
   * Adopt an existing card_id + messageId (for degradation from streaming mode).
   */
  adoptCard(cardId: string, messageId: string, sequence: number): void {
    this.cardId = cardId;
    this._messageId = messageId;
    this.sequence = sequence;
  }
}

// ─── Streaming Mode Backend ───────────────────────────────────

export class StreamingModeBackend {
  private cardId: string | null = null;
  private _messageId: string | null = null;
  private sequence = 0;
  private lastMainHash = '';
  private lastAuxBeforeHash = '';
  private lastAuxAfterHash = '';
  private readonly client: lark.Client;

  constructor(client: lark.Client) {
    this.client = client;
  }

  get messageId(): string | null {
    return this._messageId;
  }

  getCardId(): string | null {
    return this.cardId;
  }

  getSequence(): number {
    return this.sequence;
  }

  private nextSequence(): number {
    return ++this.sequence;
  }

  /**
   * Create a CardKit card instance with streaming_mode enabled.
   */
  async createCard(cardJson: object): Promise<string> {
    const resp = await this.client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardJson),
      },
    });

    const cardId = resp?.data?.card_id;
    if (!cardId) {
      const code = (resp as any)?.code;
      const msg = (resp as any)?.msg;
      throw new Error(
        `Streaming card.create returned no card_id (code=${code}, msg=${msg})`,
      );
    }

    this.cardId = cardId;
    this.sequence = 1;
    logger.debug({ cardId }, 'Streaming mode card created');
    return cardId;
  }

  /**
   * Send the card as a message. Returns message_id.
   */
  async sendCard(chatId: string, replyToMsgId?: string): Promise<string> {
    if (!this.cardId) throw new Error('Cannot sendCard before createCard');

    const content = JSON.stringify({
      type: 'card',
      data: { card_id: this.cardId },
    });

    let resp: any;
    if (replyToMsgId) {
      resp = await this.client.im.message.reply({
        path: { message_id: replyToMsgId },
        data: { content, msg_type: 'interactive' },
      });
    } else {
      resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content },
      });
    }

    const messageId = resp?.data?.message_id;
    if (!messageId)
      throw new Error('No message_id in streaming sendCard response');

    this._messageId = messageId;
    return messageId;
  }

  /**
   * Stream text content via cardElement.content() — platform renders typewriter effect.
   * MD5 dedup to avoid redundant pushes.
   * Auto-retries once on streaming timeout/closed errors.
   */
  async streamContent(text: string): Promise<void> {
    if (!this.cardId) return;

    // Truncate at 100K char limit (hint at end, slice adjusted for hint length)
    const truncHint = `\n\n> ⚠️ 输出已截断（超过 ${MAX_STREAMING_CONTENT} 字符）`;
    const content =
      text.length > MAX_STREAMING_CONTENT
        ? text.slice(0, MAX_STREAMING_CONTENT - truncHint.length) + truncHint
        : text;

    const hash = quickHash(content);
    if (hash === this.lastMainHash) return;

    try {
      await this.client.cardkit.v1.cardElement.content({
        path: { card_id: this.cardId, element_id: ELEMENT_IDS.MAIN_CONTENT },
        data: { content, sequence: this.nextSequence() },
      });
      this.lastMainHash = hash;
    } catch (err: any) {
      const code = err?.code ?? err?.response?.data?.code;
      // 200850 = streaming timeout, 300309 = streaming closed
      if (code === 200850 || code === 300309) {
        logger.info(
          { code, cardId: this.cardId },
          'Streaming mode expired, re-enabling',
        );
        await this.enableStreamingMode();
        // Retry once
        await this.client.cardkit.v1.cardElement.content({
          path: { card_id: this.cardId, element_id: ELEMENT_IDS.MAIN_CONTENT },
          data: { content, sequence: this.nextSequence() },
        });
        this.lastMainHash = hash;
      } else {
        throw err;
      }
    }
  }

  /**
   * Update an auxiliary element via cardElement.update() — instant replacement.
   */
  async updateAuxiliary(
    elementId: typeof ELEMENT_IDS.AUX_BEFORE | typeof ELEMENT_IDS.AUX_AFTER,
    content: string,
  ): Promise<void> {
    if (!this.cardId) return;

    const hash = quickHash(content);
    const hashField =
      elementId === ELEMENT_IDS.AUX_BEFORE
        ? 'lastAuxBeforeHash'
        : 'lastAuxAfterHash';
    if (hash === this[hashField]) return;

    const element = JSON.stringify({
      tag: 'markdown',
      content,
      element_id: elementId,
      text_size: 'notation',
    });

    await this.client.cardkit.v1.cardElement.update({
      path: { card_id: this.cardId, element_id: elementId },
      data: { element, sequence: this.nextSequence() },
    });
    this[hashField] = hash;
  }

  /**
   * Enable streaming mode via card.settings().
   */
  async enableStreamingMode(): Promise<void> {
    if (!this.cardId) return;
    await this.client.cardkit.v1.card.settings({
      path: { card_id: this.cardId },
      data: {
        settings: JSON.stringify({
          config: {
            streaming_mode: true,
            streaming_config: STREAMING_CONFIG,
          },
        }),
        sequence: this.nextSequence(),
      },
    });
  }

  /**
   * Disable streaming mode via card.settings().
   */
  async disableStreamingMode(): Promise<void> {
    if (!this.cardId) return;
    await this.client.cardkit.v1.card.settings({
      path: { card_id: this.cardId },
      data: {
        settings: JSON.stringify({
          config: { streaming_mode: false },
        }),
        sequence: this.nextSequence(),
      },
    });
  }

  /**
   * Full card update (used for final state after disabling streaming).
   */
  async updateCardFull(cardJson: object): Promise<void> {
    if (!this.cardId) return;
    await this.client.cardkit.v1.card.update({
      path: { card_id: this.cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(cardJson) },
        sequence: this.nextSequence(),
      },
    });
  }
}

// ─── Multi-Card Manager ───────────────────────────────────────

export class MultiCardManager {
  private cards: CardKitBackend[] = [];
  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly onCardCreated?: (messageId: string) => void;
  private cardIndex = 0;
  private readonly MAX_ELEMENTS = 45; // safety margin (Feishu limit ~50)

  constructor(
    client: lark.Client,
    chatId: string,
    replyToMsgId?: string,
    onCardCreated?: (messageId: string) => void,
  ) {
    this.client = client;
    this.chatId = chatId;
    this.replyToMsgId = replyToMsgId;
    this.onCardCreated = onCardCreated;
  }

  getCardCount(): number {
    return this.cards.length;
  }

  /**
   * Create the first card and send it as a message.
   * Returns the initial messageId.
   */
  async initialize(initialText: string): Promise<string> {
    const card = new CardKitBackend(this.client);
    const cardJson = buildSchema2Card(initialText, 'streaming');
    await card.createCard(cardJson);
    const messageId = await card.sendCard(this.chatId, this.replyToMsgId);
    this.cards.push(card);
    this.cardIndex = 0;
    return messageId;
  }

  /**
   * Adopt an existing card (for degradation from streaming mode, avoids creating a new message).
   */
  adoptExistingCard(card: CardKitBackend): void {
    this.cards.push(card);
    this.cardIndex = 0;
  }

  /**
   * Commit content: update the current card, auto-splitting if needed.
   */
  async commitContent(
    text: string,
    state: 'streaming' | 'completed' | 'aborted',
    auxiliaryState?: AuxiliaryState,
    footerNote?: string,
  ): Promise<void> {
    const titlePrefix = this.cardIndex > 0 ? '(续) ' : '';

    // Estimate element count: content + auxiliary + fixed elements
    const { contentElements } = buildCardContent(text, splitCodeBlockSafe);
    const auxCount = auxiliaryState
      ? (() => {
          const { before, after } = buildAuxiliaryElements(auxiliaryState);
          return before.length + after.length;
        })()
      : 0;
    const fixedCount =
      (state === 'streaming' ? 1 : 0) + // button
      (SCHEMA2_NOTE_MAP[state] ? 1 : 0) + // note
      (footerNote ? 1 : 0); // footer
    const totalElements = contentElements.length + auxCount + fixedCount;

    if (totalElements > this.MAX_ELEMENTS && state === 'streaming') {
      // Need to split: freeze current card and create a new one
      await this.splitToNewCard(text);
      return;
    }

    // Normal update on current card
    const currentCard = this.cards[this.cards.length - 1];
    if (!currentCard) return;

    const cardJson = buildSchema2Card(
      text,
      state,
      titlePrefix,
      undefined,
      auxiliaryState,
      footerNote,
    );

    // Byte size check (Feishu limit ~30KB, use 25KB safety margin)
    const cardSize = Buffer.byteLength(JSON.stringify(cardJson), 'utf-8');
    if (cardSize > CARD_SIZE_LIMIT && state === 'streaming') {
      await this.splitToNewCard(text);
      return;
    }

    await currentCard.updateCard(cardJson);
  }

  /**
   * Split content across cards when element limit is reached.
   */
  private async splitToNewCard(text: string): Promise<void> {
    const currentCard = this.cards[this.cards.length - 1];
    if (!currentCard) return;

    // Extract title once so all sub-cards share the same title
    const { title: consistentTitle } = extractTitleAndBody(text);

    // Determine how much content the current card can hold
    const maxChunksPerCard = this.MAX_ELEMENTS - 3; // reserve for fixed elements
    const chunks = splitCodeBlockSafe(text, CARD_MD_LIMIT);

    // Content for the current (frozen) card
    const frozenChunks = chunks.slice(0, maxChunksPerCard);
    const frozenText = frozenChunks.join('\n\n');
    const titlePrefix = this.cardIndex > 0 ? '(续) ' : '';

    // Freeze current card with consistent title
    const frozenCard = buildSchema2Card(
      frozenText,
      'frozen',
      titlePrefix,
      consistentTitle,
    );
    await currentCard.updateCard(frozenCard);

    // Create new card for remaining content
    this.cardIndex++;
    const newTitlePrefix = '(续) ';
    const remainingChunks = chunks.slice(maxChunksPerCard);
    const remainingText = remainingChunks.join('\n\n');

    const newCard = new CardKitBackend(this.client);
    const newCardJson = buildSchema2Card(
      remainingText || '...',
      'streaming',
      newTitlePrefix,
      consistentTitle,
    );
    await newCard.createCard(newCardJson);
    // New card is sent as a fresh message (not reply)
    const newMessageId = await newCard.sendCard(this.chatId);
    this.cards.push(newCard);

    // Register the new card's messageId for interrupt button routing
    this.onCardCreated?.(newMessageId);
  }

  getAllMessageIds(): string[] {
    return this.cards
      .map((c) => c.messageId)
      .filter((id): id is string => id !== null);
  }

  getLatestMessageId(): string | null {
    for (let i = this.cards.length - 1; i >= 0; i--) {
      if (this.cards[i].messageId) return this.cards[i].messageId;
    }
    return null;
  }
}

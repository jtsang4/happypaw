import type {
  BalanceOperatorType,
  BalanceReferenceType,
  BalanceTransaction,
  BalanceTransactionSource,
  BalanceTransactionType,
  BillingAuditEventType,
  BillingAuditLog,
  BillingPlan,
  DailyUsage,
  MonthlyUsage,
  RedeemCode,
  UserBalance,
  UserSubscription,
} from '../types.js';

import { db } from './shared.js';

export function cleanupOldDailyUsage(retentionDays = 90): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const result = db
    .prepare('DELETE FROM daily_usage WHERE date < ?')
    .run(cutoff);
  return result.changes;
}

export function cleanupOldBillingAuditLog(retentionDays = 365): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare('DELETE FROM billing_audit_log WHERE created_at < ?')
    .run(cutoff);
  return result.changes;
}

export function getBillingPlan(id: string): BillingPlan | undefined {
  const row = db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapBillingPlanRow(row) : undefined;
}

export function getActiveBillingPlans(): BillingPlan[] {
  return (
    db
      .prepare(
        'SELECT * FROM billing_plans WHERE is_active = 1 ORDER BY tier ASC, name ASC',
      )
      .all() as Record<string, unknown>[]
  ).map(mapBillingPlanRow);
}

export function getAllBillingPlans(): BillingPlan[] {
  return (
    db
      .prepare('SELECT * FROM billing_plans ORDER BY tier ASC, name ASC')
      .all() as Record<string, unknown>[]
  ).map(mapBillingPlanRow);
}

export function getDefaultBillingPlan(): BillingPlan | undefined {
  const row = db
    .prepare('SELECT * FROM billing_plans WHERE is_default = 1')
    .get() as Record<string, unknown> | undefined;
  return row ? mapBillingPlanRow(row) : undefined;
}

export function createBillingPlan(plan: BillingPlan): void {
  db.transaction(() => {
    // Clear old default BEFORE inserting the new plan to avoid brief dual-default
    if (plan.is_default) {
      db.prepare(
        'UPDATE billing_plans SET is_default = 0 WHERE is_default = 1',
      ).run();
    }
    db.prepare(
      `INSERT INTO billing_plans (id, name, description, tier, monthly_cost_usd, monthly_token_quota, monthly_cost_quota,
       daily_cost_quota, weekly_cost_quota, daily_token_quota, weekly_token_quota,
       rate_multiplier, trial_days, sort_order, display_price, highlight,
       max_groups, max_concurrent_containers, max_im_channels, max_mcp_servers, max_storage_mb,
       allow_overage, features, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      plan.id,
      plan.name,
      plan.description,
      plan.tier,
      plan.monthly_cost_usd,
      plan.monthly_token_quota,
      plan.monthly_cost_quota,
      plan.daily_cost_quota,
      plan.weekly_cost_quota,
      plan.daily_token_quota,
      plan.weekly_token_quota,
      plan.rate_multiplier,
      plan.trial_days,
      plan.sort_order,
      plan.display_price,
      plan.highlight ? 1 : 0,
      plan.max_groups,
      plan.max_concurrent_containers,
      plan.max_im_channels,
      plan.max_mcp_servers,
      plan.max_storage_mb,
      plan.allow_overage ? 1 : 0,
      JSON.stringify(plan.features),
      plan.is_default ? 1 : 0,
      plan.is_active ? 1 : 0,
      plan.created_at,
      plan.updated_at,
    );
  })();
}

export function updateBillingPlan(
  id: string,
  updates: Partial<Omit<BillingPlan, 'id' | 'created_at'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.tier !== undefined) {
    fields.push('tier = ?');
    values.push(updates.tier);
  }
  if (updates.monthly_cost_usd !== undefined) {
    fields.push('monthly_cost_usd = ?');
    values.push(updates.monthly_cost_usd);
  }
  if (updates.monthly_token_quota !== undefined) {
    fields.push('monthly_token_quota = ?');
    values.push(updates.monthly_token_quota);
  }
  if (updates.monthly_cost_quota !== undefined) {
    fields.push('monthly_cost_quota = ?');
    values.push(updates.monthly_cost_quota);
  }
  if (updates.daily_cost_quota !== undefined) {
    fields.push('daily_cost_quota = ?');
    values.push(updates.daily_cost_quota);
  }
  if (updates.weekly_cost_quota !== undefined) {
    fields.push('weekly_cost_quota = ?');
    values.push(updates.weekly_cost_quota);
  }
  if (updates.daily_token_quota !== undefined) {
    fields.push('daily_token_quota = ?');
    values.push(updates.daily_token_quota);
  }
  if (updates.weekly_token_quota !== undefined) {
    fields.push('weekly_token_quota = ?');
    values.push(updates.weekly_token_quota);
  }
  if (updates.rate_multiplier !== undefined) {
    fields.push('rate_multiplier = ?');
    values.push(updates.rate_multiplier);
  }
  if (updates.trial_days !== undefined) {
    fields.push('trial_days = ?');
    values.push(updates.trial_days);
  }
  if (updates.sort_order !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sort_order);
  }
  if (updates.display_price !== undefined) {
    fields.push('display_price = ?');
    values.push(updates.display_price);
  }
  if (updates.highlight !== undefined) {
    fields.push('highlight = ?');
    values.push(updates.highlight ? 1 : 0);
  }
  if (updates.max_groups !== undefined) {
    fields.push('max_groups = ?');
    values.push(updates.max_groups);
  }
  if (updates.max_concurrent_containers !== undefined) {
    fields.push('max_concurrent_containers = ?');
    values.push(updates.max_concurrent_containers);
  }
  if (updates.max_im_channels !== undefined) {
    fields.push('max_im_channels = ?');
    values.push(updates.max_im_channels);
  }
  if (updates.max_mcp_servers !== undefined) {
    fields.push('max_mcp_servers = ?');
    values.push(updates.max_mcp_servers);
  }
  if (updates.max_storage_mb !== undefined) {
    fields.push('max_storage_mb = ?');
    values.push(updates.max_storage_mb);
  }
  if (updates.allow_overage !== undefined) {
    fields.push('allow_overage = ?');
    values.push(updates.allow_overage ? 1 : 0);
  }
  if (updates.features !== undefined) {
    fields.push('features = ?');
    values.push(JSON.stringify(updates.features));
  }
  if (updates.is_default !== undefined) {
    fields.push('is_default = ?');
    values.push(updates.is_default ? 1 : 0);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active ? 1 : 0);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.transaction(() => {
    // Clear old default BEFORE setting new one to avoid brief dual-default state
    if (updates.is_default) {
      db.prepare('UPDATE billing_plans SET is_default = 0 WHERE id != ?').run(
        id,
      );
    }
    db.prepare(
      `UPDATE billing_plans SET ${fields.join(', ')} WHERE id = ?`,
    ).run(...values);
  })();
}

export function deleteBillingPlan(id: string): boolean {
  // Don't delete if users are subscribed
  const hasSubscribers = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ? AND status = 'active'",
    )
    .get(id) as { cnt: number };
  if (hasSubscribers.cnt > 0) return false;
  const result = db.prepare('DELETE FROM billing_plans WHERE id = ?').run(id);
  return result.changes > 0;
}

function mapBillingPlanRow(row: Record<string, unknown>): BillingPlan {
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
    tier: Number(row.tier) || 0,
    monthly_cost_usd: Number(row.monthly_cost_usd) || 0,
    monthly_token_quota:
      row.monthly_token_quota != null ? Number(row.monthly_token_quota) : null,
    monthly_cost_quota:
      row.monthly_cost_quota != null ? Number(row.monthly_cost_quota) : null,
    daily_cost_quota:
      row.daily_cost_quota != null ? Number(row.daily_cost_quota) : null,
    weekly_cost_quota:
      row.weekly_cost_quota != null ? Number(row.weekly_cost_quota) : null,
    daily_token_quota:
      row.daily_token_quota != null ? Number(row.daily_token_quota) : null,
    weekly_token_quota:
      row.weekly_token_quota != null ? Number(row.weekly_token_quota) : null,
    rate_multiplier: Number(row.rate_multiplier) || 1.0,
    trial_days: row.trial_days != null ? Number(row.trial_days) : null,
    sort_order: Number(row.sort_order) || 0,
    display_price:
      typeof row.display_price === 'string' ? row.display_price : null,
    highlight: !!(row.highlight as number),
    max_groups: row.max_groups != null ? Number(row.max_groups) : null,
    max_concurrent_containers:
      row.max_concurrent_containers != null
        ? Number(row.max_concurrent_containers)
        : null,
    max_im_channels:
      row.max_im_channels != null ? Number(row.max_im_channels) : null,
    max_mcp_servers:
      row.max_mcp_servers != null ? Number(row.max_mcp_servers) : null,
    max_storage_mb:
      row.max_storage_mb != null ? Number(row.max_storage_mb) : null,
    allow_overage: !!(row.allow_overage as number),
    features: safeParseJsonArray(row.features),
    is_default: !!(row.is_default as number),
    is_active: !!(row.is_active as number),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function safeParseJsonArray(val: unknown): string[] {
  if (typeof val !== 'string') return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- User Subscriptions ---

export function getUserActiveSubscription(
  userId: string,
): (UserSubscription & { plan: BillingPlan }) | undefined {
  const row = db
    .prepare(
      `SELECT s.*, p.name as plan_name FROM user_subscriptions s
       JOIN billing_plans p ON s.plan_id = p.id
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const plan = getBillingPlan(String(row.plan_id));
  if (!plan) return undefined;
  return { ...mapSubscriptionRow(row), plan };
}

export function createUserSubscription(sub: UserSubscription): void {
  // Cancel existing active subscriptions
  db.prepare(
    "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
  ).run(new Date().toISOString(), sub.user_id);

  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at, trial_ends_at, notes, auto_renew, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sub.id,
    sub.user_id,
    sub.plan_id,
    sub.status,
    sub.started_at,
    sub.expires_at,
    sub.cancelled_at,
    sub.trial_ends_at,
    sub.notes,
    sub.auto_renew ? 1 : 0,
    sub.created_at,
  );

  // Update user's subscription_plan_id
  db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
    sub.plan_id,
    sub.user_id,
  );
}

export function cancelUserSubscription(userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
  ).run(now, userId);
  db.prepare('UPDATE users SET subscription_plan_id = NULL WHERE id = ?').run(
    userId,
  );
}

export function expireSubscriptions(): number {
  const now = new Date().toISOString();

  // Phase 1: Handle auto_renew=1 subscriptions — renew them instead of expiring
  const renewableRows = db
    .prepare(
      "SELECT * FROM user_subscriptions WHERE status = 'active' AND auto_renew = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .all(now) as Record<string, unknown>[];

  let renewed = 0;
  for (const row of renewableRows) {
    const userId = String(row.user_id);
    const planId = String(row.plan_id);
    const oldId = String(row.id);
    const oldStarted = String(row.started_at);
    const oldExpires = String(row.expires_at);

    // Calculate same duration as original subscription
    const startMs = new Date(oldStarted).getTime();
    const expiresMs = new Date(oldExpires).getTime();
    const durationMs = expiresMs - startMs;
    if (durationMs <= 0) continue;

    const plan = getBillingPlan(planId);
    if (!plan || !plan.is_active) {
      // Plan no longer active, expire instead
      continue;
    }

    // Check if user has sufficient balance for paid plans
    if (plan.monthly_cost_usd > 0) {
      const balance = getUserBalance(userId);
      if (balance.balance_usd < plan.monthly_cost_usd) {
        // Insufficient balance, expire instead
        logBillingAudit('subscription_expired', userId, null, {
          planId,
          planName: plan.name,
          reason: 'insufficient_balance_for_renewal',
          balance: balance.balance_usd,
          required: plan.monthly_cost_usd,
        });
        continue;
      }
    }

    // Wrap the entire renewal in a transaction for atomicity
    const renewTx = db.transaction(() => {
      // Deduct subscription cost (if paid plan)
      if (plan.monthly_cost_usd > 0) {
        adjustUserBalance(
          userId,
          -plan.monthly_cost_usd,
          'deduction',
          `自动续费: ${plan.name}`,
          'subscription',
          oldId,
          null,
          null,
          {
            source: 'subscription_renewal',
            operatorType: 'system',
            notes: `自动续费扣款: ${plan.name}`,
          },
        );
      }

      // Expire old subscription
      db.prepare(
        "UPDATE user_subscriptions SET status = 'expired' WHERE id = ?",
      ).run(oldId);

      // Create new subscription with same duration
      const newNow = new Date();
      const newExpires = new Date(newNow.getTime() + durationMs).toISOString();
      const newSub = {
        id: `sub_${userId}_${Date.now()}_renew`,
        user_id: userId,
        plan_id: planId,
        status: 'active',
        started_at: newNow.toISOString(),
        expires_at: newExpires,
        cancelled_at: null,
        trial_ends_at: null,
        notes: '自动续费',
        auto_renew: 1,
        created_at: newNow.toISOString(),
      };

      db.prepare(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at, trial_ends_at, notes, auto_renew, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newSub.id,
        newSub.user_id,
        newSub.plan_id,
        newSub.status,
        newSub.started_at,
        newSub.expires_at,
        newSub.cancelled_at,
        newSub.trial_ends_at,
        newSub.notes,
        newSub.auto_renew,
        newSub.created_at,
      );

      logBillingAudit('subscription_assigned', userId, null, {
        planId,
        planName: plan.name,
        autoRenew: true,
        renewedFrom: oldId,
      });
    });

    try {
      renewTx();
      renewed++;
    } catch (err) {
      logBillingAudit('subscription_expired', userId, null, {
        planId,
        planName: plan.name,
        reason: 'renewal_transaction_failed',
        error: String(err),
      });
    }
  }

  // Phase 2: Expire remaining (non-auto-renew or failed renewal)
  const result = db
    .prepare(
      "UPDATE user_subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .run(now);
  return result.changes + renewed;
}

export function updateSubscriptionAutoRenew(
  userId: string,
  autoRenew: boolean,
): boolean {
  const result = db
    .prepare(
      "UPDATE user_subscriptions SET auto_renew = ? WHERE user_id = ? AND status = 'active'",
    )
    .run(autoRenew ? 1 : 0, userId);
  return result.changes > 0;
}

function mapSubscriptionRow(row: Record<string, unknown>): UserSubscription {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    plan_id: String(row.plan_id),
    status: String(row.status) as UserSubscription['status'],
    started_at: String(row.started_at),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    cancelled_at:
      typeof row.cancelled_at === 'string' ? row.cancelled_at : null,
    trial_ends_at:
      typeof row.trial_ends_at === 'string' ? row.trial_ends_at : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    auto_renew: !!(row.auto_renew as number),
    created_at: String(row.created_at),
  };
}

// --- User Balances ---

export function getUserBalance(userId: string): UserBalance {
  const row = db
    .prepare('SELECT * FROM user_balances WHERE user_id = ?')
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) {
    // Auto-init balance
    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(userId, now);
    return {
      user_id: userId,
      balance_usd: 0,
      total_deposited_usd: 0,
      total_consumed_usd: 0,
      updated_at: now,
    };
  }
  return {
    user_id: String(row.user_id),
    balance_usd: Number(row.balance_usd) || 0,
    total_deposited_usd: Number(row.total_deposited_usd) || 0,
    total_consumed_usd: Number(row.total_consumed_usd) || 0,
    updated_at: String(row.updated_at),
  };
}

export function adjustUserBalance(
  userId: string,
  amount: number,
  type: BalanceTransactionType,
  description: string | null,
  referenceType: BalanceReferenceType | null,
  referenceId: string | null,
  actorId: string | null,
  idempotencyKey?: string | null,
  options?: {
    source?: BalanceTransactionSource;
    operatorType?: BalanceOperatorType;
    notes?: string | null;
    allowNegative?: boolean;
  },
): BalanceTransaction {
  const source = options?.source ?? 'system_adjustment';
  const operatorType = options?.operatorType ?? 'system';
  const notes = options?.notes ?? description ?? null;
  const allowNegative = options?.allowNegative ?? false;

  // Idempotency check: if key already used, return the existing transaction
  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM balance_transactions WHERE idempotency_key = ?')
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        id: Number(existing.id),
        user_id: String(existing.user_id),
        type: String(existing.type) as BalanceTransactionType,
        amount_usd: Number(existing.amount_usd),
        balance_after: Number(existing.balance_after),
        description:
          typeof existing.description === 'string'
            ? existing.description
            : null,
        reference_type:
          typeof existing.reference_type === 'string'
            ? (existing.reference_type as BalanceReferenceType)
            : null,
        reference_id:
          typeof existing.reference_id === 'string'
            ? existing.reference_id
            : null,
        actor_id:
          typeof existing.actor_id === 'string' ? existing.actor_id : null,
        source:
          typeof existing.source === 'string'
            ? (existing.source as BalanceTransactionSource)
            : 'system_adjustment',
        operator_type:
          typeof existing.operator_type === 'string'
            ? (existing.operator_type as BalanceOperatorType)
            : 'system',
        notes: typeof existing.notes === 'string' ? existing.notes : null,
        idempotency_key:
          typeof existing.idempotency_key === 'string'
            ? existing.idempotency_key
            : null,
        created_at: String(existing.created_at),
      };
    }
  }

  const now = new Date().toISOString();

  // Wrap read-check-update-record in a transaction for atomicity
  const txFn = db.transaction(() => {
    // Ensure balance row exists
    db.prepare(
      'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(userId, now);

    const currentRow = db
      .prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?')
      .get(userId) as { balance_usd: number };
    const currentBalance = Number(currentRow.balance_usd);
    const nextBalance = currentBalance + amount;
    if (!allowNegative && nextBalance < 0) {
      throw new Error(
        `Balance cannot be negative: current=${currentBalance.toFixed(
          2,
        )} next=${nextBalance.toFixed(2)}`,
      );
    }

    // Update balance
    if (amount > 0) {
      db.prepare(
        'UPDATE user_balances SET balance_usd = balance_usd + ?, total_deposited_usd = total_deposited_usd + ?, updated_at = ? WHERE user_id = ?',
      ).run(amount, amount, now, userId);
    } else {
      db.prepare(
        'UPDATE user_balances SET balance_usd = balance_usd + ?, total_consumed_usd = total_consumed_usd + ?, updated_at = ? WHERE user_id = ?',
      ).run(amount, Math.abs(amount), now, userId);
    }

    // Read new balance within the same transaction
    const newRow = db
      .prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?')
      .get(userId) as { balance_usd: number };
    const balanceAfter = Number(newRow.balance_usd);

    // Record transaction
    const result = db
      .prepare(
        `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        type,
        amount,
        balanceAfter,
        description,
        referenceType,
        referenceId,
        actorId,
        source,
        operatorType,
        notes,
        now,
        idempotencyKey ?? null,
      );

    return {
      id: Number(result.lastInsertRowid),
      balanceAfter,
    };
  });

  const { id: txId, balanceAfter } = txFn();

  return {
    id: txId,
    user_id: userId,
    type,
    amount_usd: amount,
    balance_after: balanceAfter,
    description,
    reference_type: referenceType,
    reference_id: referenceId,
    actor_id: actorId,
    source,
    operator_type: operatorType,
    notes,
    idempotency_key: idempotencyKey ?? null,
    created_at: now,
  };
}

export function getBalanceTransactions(
  userId: string,
  limit = 50,
  offset = 0,
): { transactions: BalanceTransaction[]; total: number } {
  const total = (
    db
      .prepare(
        'SELECT COUNT(*) as cnt FROM balance_transactions WHERE user_id = ?',
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(
      'SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    )
    .all(userId, limit, offset) as Record<string, unknown>[];

  return {
    transactions: rows.map((r) => ({
      id: Number(r.id),
      user_id: String(r.user_id),
      type: String(r.type) as BalanceTransactionType,
      amount_usd: Number(r.amount_usd),
      balance_after: Number(r.balance_after),
      description: typeof r.description === 'string' ? r.description : null,
      reference_type:
        typeof r.reference_type === 'string'
          ? (r.reference_type as BalanceReferenceType)
          : null,
      reference_id: typeof r.reference_id === 'string' ? r.reference_id : null,
      actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
      source:
        typeof r.source === 'string'
          ? (r.source as BalanceTransactionSource)
          : 'system_adjustment',
      operator_type:
        typeof r.operator_type === 'string'
          ? (r.operator_type as BalanceOperatorType)
          : 'system',
      notes: typeof r.notes === 'string' ? r.notes : null,
      idempotency_key:
        typeof r.idempotency_key === 'string' ? r.idempotency_key : null,
      created_at: String(r.created_at),
    })),
    total,
  };
}

// --- Monthly Usage ---

function mapMonthlyUsageRow(row: Record<string, unknown>): MonthlyUsage {
  return {
    user_id: String(row.user_id),
    month: String(row.month),
    total_input_tokens: Number(row.total_input_tokens) || 0,
    total_output_tokens: Number(row.total_output_tokens) || 0,
    total_cost_usd: Number(row.total_cost_usd) || 0,
    message_count: Number(row.message_count) || 0,
    updated_at: String(row.updated_at),
  };
}

export function getMonthlyUsage(
  userId: string,
  month: string,
): MonthlyUsage | undefined {
  const row = db
    .prepare('SELECT * FROM monthly_usage WHERE user_id = ? AND month = ?')
    .get(userId, month) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapMonthlyUsageRow(row);
}

export function incrementMonthlyUsage(
  userId: string,
  month: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1,
       updated_at = excluded.updated_at`,
  ).run(userId, month, inputTokens, outputTokens, costUsd, now);
}

export function getUserMonthlyUsageHistory(
  userId: string,
  months = 6,
): MonthlyUsage[] {
  return (
    db
      .prepare(
        'SELECT * FROM monthly_usage WHERE user_id = ? ORDER BY month DESC LIMIT ?',
      )
      .all(userId, months) as Record<string, unknown>[]
  ).map(mapMonthlyUsageRow);
}

// --- Redeem Codes ---

export function getRedeemCode(code: string): RedeemCode | undefined {
  const row = db
    .prepare('SELECT * FROM redeem_codes WHERE code = ?')
    .get(code) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapRedeemCodeRow(row);
}

export function getAllRedeemCodes(): RedeemCode[] {
  return (
    db
      .prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC')
      .all() as Record<string, unknown>[]
  ).map(mapRedeemCodeRow);
}

export function createRedeemCode(code: RedeemCode): void {
  db.prepare(
    `INSERT INTO redeem_codes (code, type, value_usd, plan_id, duration_days, max_uses, used_count, expires_at, created_by, notes, batch_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    code.code,
    code.type,
    code.value_usd,
    code.plan_id,
    code.duration_days,
    code.max_uses,
    code.used_count,
    code.expires_at,
    code.created_by,
    code.notes,
    code.batch_id,
    code.created_at,
  );
}

export function incrementRedeemCodeUsage(code: string, userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?',
  ).run(code);
  db.prepare(
    'INSERT INTO redeem_code_usage (code, user_id, redeemed_at) VALUES (?, ?, ?)',
  ).run(code, userId, now);
}

export function deleteRedeemCode(code: string): boolean {
  const result = db
    .prepare('DELETE FROM redeem_codes WHERE code = ?')
    .run(code);
  return result.changes > 0;
}

export function hasUserRedeemedCode(userId: string, code: string): boolean {
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM redeem_code_usage WHERE user_id = ? AND code = ?',
    )
    .get(userId, code) as { cnt: number };
  return row.cnt > 0;
}

function mapRedeemCodeRow(row: Record<string, unknown>): RedeemCode {
  return {
    code: String(row.code),
    type: String(row.type) as RedeemCode['type'],
    value_usd: row.value_usd != null ? Number(row.value_usd) : null,
    plan_id: typeof row.plan_id === 'string' ? row.plan_id : null,
    duration_days: row.duration_days != null ? Number(row.duration_days) : null,
    max_uses: Number(row.max_uses) || 1,
    used_count: Number(row.used_count) || 0,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_by: String(row.created_by),
    notes: typeof row.notes === 'string' ? row.notes : null,
    batch_id: typeof row.batch_id === 'string' ? row.batch_id : null,
    created_at: String(row.created_at),
  };
}

// --- Billing Audit Log ---

export function logBillingAudit(
  eventType: BillingAuditEventType,
  userId: string,
  actorId: string | null,
  details: Record<string, unknown> | null,
): void {
  db.prepare(
    'INSERT INTO billing_audit_log (event_type, user_id, actor_id, details, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    eventType,
    userId,
    actorId,
    details ? JSON.stringify(details) : null,
    new Date().toISOString(),
  );
}

export function getBillingAuditLog(
  limit = 50,
  offset = 0,
  userId?: string,
  eventType?: string,
): { logs: BillingAuditLog[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (eventType) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM billing_audit_log ${where}`)
      .get(...params) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(
      `SELECT * FROM billing_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return {
    logs: rows.map((r) => ({
      id: Number(r.id),
      event_type: String(r.event_type) as BillingAuditEventType,
      user_id: String(r.user_id),
      actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
      details:
        typeof r.details === 'string'
          ? (JSON.parse(r.details) as Record<string, unknown>)
          : null,
      created_at: String(r.created_at),
    })),
    total,
  };
}

// --- Billing summary helpers ---

export function getUserGroupCount(userId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT rg.folder) as cnt FROM registered_groups rg WHERE rg.created_by = ? AND rg.jid LIKE 'web:%'",
    )
    .get(userId) as { cnt: number };
  return row.cnt;
}

export function getAllUserBillingOverview(): Array<{
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  plan_id: string | null;
  plan_name: string | null;
  balance_usd: number;
  current_month_cost: number;
}> {
  const month = new Date().toISOString().slice(0, 7);
  return db
    .prepare(
      `SELECT u.id as user_id, u.username, u.display_name, u.role,
              s.plan_id, p.name as plan_name,
              COALESCE(b.balance_usd, 0) as balance_usd,
              COALESCE(mu.total_cost_usd, 0) as current_month_cost
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
       LEFT JOIN billing_plans p ON p.id = s.plan_id
       LEFT JOIN user_balances b ON b.user_id = u.id
       LEFT JOIN monthly_usage mu ON mu.user_id = u.id AND mu.month = ?
       WHERE u.status != 'deleted'
       ORDER BY u.created_at ASC`,
    )
    .all(month) as Array<{
    user_id: string;
    username: string;
    display_name: string;
    role: string;
    plan_id: string | null;
    plan_name: string | null;
    balance_usd: number;
    current_month_cost: number;
  }>;
}

export function getRevenueStats(): {
  totalDeposited: number;
  totalConsumed: number;
  activeSubscriptions: number;
  currentMonthRevenue: number;
} {
  const month = new Date().toISOString().slice(0, 7);
  const deposited = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_deposited_usd), 0) as total FROM user_balances',
      )
      .get() as { total: number }
  ).total;
  const consumed = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_consumed_usd), 0) as total FROM user_balances',
      )
      .get() as { total: number }
  ).total;
  const activeSubs = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
      )
      .get() as { cnt: number }
  ).cnt;
  const monthRevenue = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
      )
      .get(month) as { total: number }
  ).total;
  return {
    totalDeposited: deposited,
    totalConsumed: consumed,
    activeSubscriptions: activeSubs,
    currentMonthRevenue: monthRevenue,
  };
}

// --- Daily Usage ---

function mapDailyUsageRow(row: Record<string, unknown>): DailyUsage {
  return {
    user_id: String(row.user_id),
    date: String(row.date),
    total_input_tokens: Number(row.total_input_tokens) || 0,
    total_output_tokens: Number(row.total_output_tokens) || 0,
    total_cost_usd: Number(row.total_cost_usd) || 0,
    message_count: Number(row.message_count) || 0,
  };
}

export function incrementDailyUsage(
  userId: string,
  date: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  db.prepare(
    `INSERT INTO daily_usage (user_id, date, total_input_tokens, total_output_tokens, total_cost_usd, message_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, date) DO UPDATE SET
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1`,
  ).run(userId, date, inputTokens, outputTokens, costUsd);
}

export function getDailyUsage(
  userId: string,
  date: string,
): DailyUsage | undefined {
  const row = db
    .prepare('SELECT * FROM daily_usage WHERE user_id = ? AND date = ?')
    .get(userId, date) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapDailyUsageRow(row);
}

export function getWeeklyUsageSummary(userId: string): {
  totalCost: number;
  totalTokens: number;
} {
  // Align to calendar week (Monday–Sunday) to match checkQuota() reset logic
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMonday);
  const startDate = monday.toISOString().slice(0, 10);

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as totalCost,
              COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as totalTokens
       FROM daily_usage WHERE user_id = ? AND date >= ?`,
    )
    .get(userId, startDate) as { totalCost: number; totalTokens: number };
  return { totalCost: row.totalCost, totalTokens: row.totalTokens };
}

export function getUserDailyUsageHistory(
  userId: string,
  days = 14,
): DailyUsage[] {
  return (
    db
      .prepare(
        'SELECT * FROM daily_usage WHERE user_id = ? ORDER BY date DESC LIMIT ?',
      )
      .all(userId, days) as Record<string, unknown>[]
  ).map(mapDailyUsageRow);
}

export function getDailyUsageSumForMonth(
  userId: string,
  month: string,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  messageCount: number;
} {
  const startDate = `${month}-01`;
  // End date: first day of next month
  const [y, m] = month.split('-').map(Number);
  const nextMonth =
    m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const endDate = `${nextMonth}-01`;

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_input_tokens), 0) as totalInputTokens,
              COALESCE(SUM(total_output_tokens), 0) as totalOutputTokens,
              COALESCE(SUM(total_cost_usd), 0) as totalCost,
              COALESCE(SUM(message_count), 0) as messageCount
       FROM daily_usage WHERE user_id = ? AND date >= ? AND date < ?`,
    )
    .get(userId, startDate, endDate) as {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    messageCount: number;
  };
  return row;
}

export function correctMonthlyUsage(
  userId: string,
  month: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  messageCount: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       total_input_tokens = excluded.total_input_tokens,
       total_output_tokens = excluded.total_output_tokens,
       total_cost_usd = excluded.total_cost_usd,
       message_count = excluded.message_count,
       updated_at = excluded.updated_at`,
  ).run(userId, month, inputTokens, outputTokens, costUsd, messageCount, now);
}

export function getSubscriptionHistory(
  userId: string,
): (UserSubscription & { plan_name: string })[] {
  return (
    db
      .prepare(
        `SELECT s.*, p.name as plan_name FROM user_subscriptions s
         JOIN billing_plans p ON s.plan_id = p.id
         WHERE s.user_id = ?
         ORDER BY s.created_at DESC`,
      )
      .all(userId) as Record<string, unknown>[]
  ).map((row) => ({
    ...mapSubscriptionRow(row),
    plan_name: String(row.plan_name),
  }));
}

export function getRedeemCodeUsageDetails(
  code: string,
): Array<{ user_id: string; username: string; redeemed_at: string }> {
  return db
    .prepare(
      `SELECT rcu.user_id, u.username, rcu.redeemed_at
       FROM redeem_code_usage rcu
       LEFT JOIN users u ON u.id = rcu.user_id
       WHERE rcu.code = ?
       ORDER BY rcu.redeemed_at DESC`,
    )
    .all(code) as Array<{
    user_id: string;
    username: string;
    redeemed_at: string;
  }>;
}

export function getDashboardStats(): {
  activeUsers: number;
  totalUsers: number;
  planDistribution: Array<{ plan_name: string; count: number }>;
  todayCost: number;
  monthCost: number;
  activeSubscriptions: number;
} {
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  const totalUsers = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE status != 'deleted'")
      .get() as { cnt: number }
  ).cnt;

  const activeUsers = (
    db
      .prepare(
        'SELECT COUNT(DISTINCT user_id) as cnt FROM daily_usage WHERE date = ?',
      )
      .get(today) as { cnt: number }
  ).cnt;

  const planDistribution = db
    .prepare(
      `SELECT COALESCE(p.name, '无套餐') as plan_name, COUNT(*) as count
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
       LEFT JOIN billing_plans p ON p.id = s.plan_id
       WHERE u.status != 'deleted'
       GROUP BY p.name
       ORDER BY count DESC`,
    )
    .all() as Array<{ plan_name: string; count: number }>;

  const todayCost = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM daily_usage WHERE date = ?',
      )
      .get(today) as { total: number }
  ).total;

  const monthCost = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
      )
      .get(month) as { total: number }
  ).total;

  const activeSubscriptions = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
      )
      .get() as { cnt: number }
  ).cnt;

  return {
    activeUsers,
    totalUsers,
    planDistribution,
    todayCost,
    monthCost,
    activeSubscriptions,
  };
}

export function getRevenueTrend(
  months = 6,
): Array<{ month: string; revenue: number; users: number }> {
  return db
    .prepare(
      `SELECT month, SUM(total_cost_usd) as revenue, COUNT(DISTINCT user_id) as users
       FROM monthly_usage
       GROUP BY month
       ORDER BY month DESC
       LIMIT ?`,
    )
    .all(months) as Array<{ month: string; revenue: number; users: number }>;
}

export function batchAssignPlan(
  userIds: string[],
  planId: string,
  actorId: string,
  durationDays?: number,
): number {
  const plan = getBillingPlan(planId);
  if (!plan) throw new Error(`Plan not found: ${planId}`);

  const now = new Date();
  const expiresAt = durationDays
    ? new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  let count = 0;
  const txn = db.transaction(() => {
    for (const userId of userIds) {
      // Cancel existing
      db.prepare(
        "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
      ).run(now.toISOString(), userId);

      const subId = `sub_${userId}_${Date.now()}_${count}`;
      db.prepare(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, auto_renew, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?)`,
      ).run(
        subId,
        userId,
        planId,
        now.toISOString(),
        expiresAt,
        now.toISOString(),
      );

      db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
        planId,
        userId,
      );

      logBillingAudit('subscription_assigned', userId, actorId, {
        planId,
        planName: plan.name,
        durationDays: durationDays ?? null,
        batch: true,
      });
      count++;
    }
  });
  txn();
  return count;
}

export function getPlanSubscriberCount(planId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ? AND status = 'active'",
    )
    .get(planId) as { cnt: number };
  return row.cnt;
}

export function getAllPlanSubscriberCounts(): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT plan_id, COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active' GROUP BY plan_id",
    )
    .all() as Array<{ plan_id: string; cnt: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.plan_id] = row.cnt;
  }
  return result;
}

/**
 * Atomically increment redeem code usage with optimistic locking.
 * Returns true if the increment succeeded (used_count < max_uses).
 */
export function tryIncrementRedeemCodeUsage(
  code: string,
  userId: string,
): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const result = db
      .prepare(
        'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
      )
      .run(code);
    if (result.changes === 0) return false;
    db.prepare(
      'INSERT INTO redeem_code_usage (code, user_id, redeemed_at) VALUES (?, ?, ?)',
    ).run(code, userId, now);
    return true;
  })();
}

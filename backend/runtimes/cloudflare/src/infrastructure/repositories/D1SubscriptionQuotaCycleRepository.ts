import type {
  SubscriptionQuotaCycleRecord,
  SubscriptionQuotaCycleRepository,
  SubscriptionQuotaScope,
  SubscriptionQuotaWindowKind,
} from '@cat-factory/kernel'
import { subscriptionVendorSchema } from '@cat-factory/contracts'
import { decodeEnum } from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'

interface SubscriptionQuotaCycleRow {
  id: string
  scope: string
  scope_id: string
  vendor: string
  window_kind: string
  window_started_at: number
  input_tokens: number
  output_tokens: number
  request_count: number
  updated_at: number
}

function rowToRecord(row: SubscriptionQuotaCycleRow): SubscriptionQuotaCycleRecord {
  return {
    id: row.id,
    scope: row.scope as SubscriptionQuotaScope,
    scopeId: row.scope_id,
    vendor: decodeEnum(subscriptionVendorSchema, row.vendor, {
      table: 'subscription_quota_cycles',
      column: 'vendor',
      id: row.id,
    }),
    windowKind: row.window_kind as SubscriptionQuotaWindowKind,
    windowStartedAt: row.window_started_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    requestCount: row.request_count,
    updatedAt: row.updated_at,
  }
}

/** D1-backed modeled subscription quota-cycle counters (migration 0047). */
export class D1SubscriptionQuotaCycleRepository implements SubscriptionQuotaCycleRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async recordUsage(
    key: {
      id: string
      scope: SubscriptionQuotaScope
      scopeId: string
      vendor: string
      windowKind: SubscriptionQuotaWindowKind
    },
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    // Windowed UPSERT: INSERT anchors a fresh window at `at`; ON CONFLICT accumulates when
    // the existing window is still active (`at - window_started_at < windowMs`) or resets
    // it to `at` otherwise. SQLite evaluates every SET RHS against the row's pre-update
    // values, so referencing `window_started_at` in the counter branches is safe even
    // though the first SET reassigns it (mirrors D1ProviderSubscriptionTokenRepository).
    const active = '(? - window_started_at < ?)'
    await this.db
      .prepare(
        `INSERT INTO subscription_quota_cycles
          (id, scope, scope_id, vendor, window_kind, window_started_at,
           input_tokens, output_tokens, request_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (scope, scope_id, vendor, window_kind) DO UPDATE SET
           window_started_at = CASE WHEN ${active} THEN window_started_at ELSE ? END,
           input_tokens      = CASE WHEN ${active} THEN input_tokens  ELSE 0 END + ?,
           output_tokens     = CASE WHEN ${active} THEN output_tokens ELSE 0 END + ?,
           request_count     = CASE WHEN ${active} THEN request_count ELSE 0 END + 1,
           updated_at        = ?`,
      )
      .bind(
        // INSERT values
        key.id,
        key.scope,
        key.scopeId,
        key.vendor,
        key.windowKind,
        at,
        usage.inputTokens,
        usage.outputTokens,
        at,
        // UPDATE branches
        at,
        windowMs,
        at,
        at,
        windowMs,
        usage.inputTokens,
        at,
        windowMs,
        usage.outputTokens,
        at,
        windowMs,
        at,
      )
      .run()
  }

  async listByScopeVendor(
    scope: SubscriptionQuotaScope,
    scopeId: string,
    vendor: string,
  ): Promise<SubscriptionQuotaCycleRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM subscription_quota_cycles
          WHERE scope = ? AND scope_id = ? AND vendor = ?`,
      )
      .bind(scope, scopeId, vendor)
      .all<SubscriptionQuotaCycleRow>()
    return (results ?? []).map(rowToRecord)
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM subscription_quota_cycles WHERE window_started_at < ?`)
      .bind(epochMs)
      .run()
    return result.meta.changes ?? 0
  }
}

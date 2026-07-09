// Persistence port for subscription quota-cycle tracking (the usage-and-quota-tracking
// initiative, Part B). A subscription harness (Claude Code / Codex / GLM / pooled Kimi &
// DeepSeek) runs on a flat-rate quota, not per-token billing, so the spend ledger
// deliberately excludes it. This table instead models "how much of the current quota
// cycle is left" by folding each finished run's tokens into rolling windows anchored at
// first observed use — the MODELED fallback used everywhere until a vendor read (Part B2)
// supplies real numbers. Both facades mirror it (D1 on Cloudflare, Drizzle/Postgres on
// Node); runtime parity is mandatory.

import type { SubscriptionVendor } from '@cat-factory/contracts'

/**
 * Whose quota a cycle belongs to:
 *  - `pooled` — a workspace's shared pool token (`scopeId` = the `provider_subscription_tokens` id).
 *  - `user`   — a user's personal (individual-usage) subscription (`scopeId` = the user id).
 * A pooled token is workspace-shared and rotated; a personal credential is per-user. This
 * mirrors the split between `provider_subscription_tokens` and `personal_subscriptions`.
 */
export type SubscriptionQuotaScope = 'pooled' | 'user'

/**
 * The rolling windows a quota cycle is modeled over. Vendors advertise a short (~5h)
 * window plus a weekly cap; both accumulate the same tokens but reset on their own
 * cadence. Extensible (e.g. a monthly window) by adding a kind here + a ceiling entry.
 */
export type SubscriptionQuotaWindowKind = '5h' | 'weekly'

/**
 * One (scope, scopeId, vendor, windowKind) counter: the accumulated usage in the current
 * window, anchored at `windowStartedAt` (the first observed use of this cycle). Reset —
 * `windowStartedAt` re-stamped and counters restarted — once the window ages past its
 * length. The modeled `usedPercent` a report derives from this is illustrative, not billed.
 */
export interface SubscriptionQuotaCycleRecord {
  id: string
  scope: SubscriptionQuotaScope
  /** The pooled token id (scope `pooled`) or the user id (scope `user`). */
  scopeId: string
  vendor: SubscriptionVendor
  windowKind: SubscriptionQuotaWindowKind
  /** Start of the current window (epoch ms) — anchored at first observed use. */
  windowStartedAt: number
  /** Input tokens consumed in the current window. */
  inputTokens: number
  /** Output tokens consumed in the current window. */
  outputTokens: number
  /** Runs counted in the current window. */
  requestCount: number
  /** When the row was last folded into (epoch ms). */
  updatedAt: number
}

export interface SubscriptionQuotaCycleRepository {
  /**
   * Fold a finished run's usage into the (scope, scopeId, vendor, windowKind) counters.
   * UPSERT: on first observed use it inserts the row (with `key.id`) and anchors the
   * window at `at`; an active window (younger than `windowMs`) accumulates; a stale one
   * resets to `at` and starts counting from this run. A single atomic statement so two
   * runs finishing on the same cycle can't lose each other's counters (mirrors
   * `ProviderSubscriptionTokenRepository.recordUsage`).
   */
  recordUsage(
    key: {
      id: string
      scope: SubscriptionQuotaScope
      scopeId: string
      vendor: SubscriptionVendor
      windowKind: SubscriptionQuotaWindowKind
    },
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void>
  /** The current cycle rows (one per window kind) for a scope + vendor. */
  listByScopeVendor(
    scope: SubscriptionQuotaScope,
    scopeId: string,
    vendor: SubscriptionVendor,
  ): Promise<SubscriptionQuotaCycleRecord[]>
  /**
   * Retention prune: delete rows whose window started before `epochMs` (exclusive),
   * returning how many were removed. A stale window is re-anchored on next use, so
   * pruning long-idle cycles caps the table without affecting a live cycle.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}

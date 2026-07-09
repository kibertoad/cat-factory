// Port for reading + recording a subscription's quota cycle (the usage-and-quota-tracking
// initiative, Part B). Modelled on `ReleaseHealthProvider`: a vendor-neutral composite
// (`RegistrySubscriptionQuotaProvider` in @cat-factory/integrations) owns persistence +
// the modeled (first-use window) fallback + the reduction, and a per-vendor adapter
// supplies the REAL vendor read where one exists (Claude `/api/oauth/usage`, GLM
// `/api/monitor/usage/quota/limit`). A vendor with no adapter degrades to the modeled
// window rather than failing. The core depends only on this interface.

import type { SubscriptionVendor } from '@cat-factory/contracts'
import type {
  SubscriptionQuotaScope,
  SubscriptionQuotaWindowKind,
} from './subscription-quota-repositories.js'

/** Whether a reported window's numbers came from a real vendor read or the modeled fallback. */
export type SubscriptionQuotaSource = 'real' | 'modeled'

/** One reported quota window (a `5h` or `weekly` cycle) for a scope + vendor. */
export interface SubscriptionQuotaWindow {
  kind: SubscriptionQuotaWindowKind
  /** Total tokens used in the current window (modeled: accumulated input + output). */
  usedTokens: number
  /**
   * The ceiling this window is measured against, in total tokens. Modeled from config
   * defaults (no vendor publishes an absolute cap); `null` when no ceiling is known.
   */
  limitTokens: number | null
  /** 0..1 fraction of `limitTokens` consumed; `null` when no ceiling is known. */
  usedPercent: number | null
  /** Start of the current window (epoch ms); `null` when no usage has been recorded yet. */
  windowStartedAt: number | null
  /** When the current window resets (epoch ms); `null` when not started. */
  resetsAt: number | null
  source: SubscriptionQuotaSource
}

/** The full quota cycle for one scope + vendor: its windows plus the overall source. */
export interface SubscriptionQuotaCycle {
  scope: SubscriptionQuotaScope
  scopeId: string
  vendor: SubscriptionVendor
  windows: SubscriptionQuotaWindow[]
  /** `real` if any window came from a vendor read, else `modeled`. */
  source: SubscriptionQuotaSource
}

/** Which subscription a call is about: a workspace pool token or a user's personal credential. */
export interface SubscriptionQuotaTarget {
  scope: SubscriptionQuotaScope
  scopeId: string
  vendor: SubscriptionVendor
}

export interface SubscriptionQuotaProvider {
  /**
   * Fold a finished run's token usage into the modeled quota-cycle counters for a scope +
   * vendor, anchoring each window at first observed use. Best-effort — a subscription run
   * counts here even when it's excluded from the (metered-only) spend ledger.
   */
  recordUsage(
    target: SubscriptionQuotaTarget,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void>
  /**
   * The current quota cycle for a scope + vendor: real windows where an adapter supplies
   * them, modeled windows (from the persisted counters + config ceilings) otherwise.
   */
  report(target: SubscriptionQuotaTarget): Promise<SubscriptionQuotaCycle>
}

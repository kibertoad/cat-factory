// Pure rotation logic for usage-aware credential pools (subscription tokens AND
// direct-provider API keys), kept separate from the services so it can be
// unit-tested without a repository. Disabled rows are never chosen. A pinned default
// (an enabled `isDefault` row) always wins; otherwise the policy is usage-aware:
// prefer the row that has consumed the fewest tokens in the current rolling window,
// falling back to least-recently-leased (round-robin) and then oldest-created for ties
// and cold-start rows.

/**
 * The fields the rotation policy needs from a pool row. Both
 * `ProviderSubscriptionTokenRecord` and `ProviderApiKeyRecord` satisfy this, so
 * `chooseToken` rotates either pool without duplication.
 */
export interface PoolRotationRecord {
  inputTokens: number
  outputTokens: number
  windowStartedAt: number | null
  lastUsedAt: number | null
  createdAt: number
  /** A disabled row is never leased. */
  enabled: boolean
  /** A pinned default (when enabled) is preferred over usage-aware rotation. */
  isDefault: boolean
}

/** Default rolling usage window (~5h) — mirrors subscription quota windows. */
export const DEFAULT_USAGE_WINDOW_MS = 5 * 60 * 60 * 1000

/** Effective window usage for a row: counters reset once the window ages out. */
export function windowUsage(record: PoolRotationRecord, now: number, windowMs: number): number {
  if (record.windowStartedAt == null || now - record.windowStartedAt >= windowMs) return 0
  return record.inputTokens + record.outputTokens
}

/**
 * Choose the next row to lease from a list of live pool rows. Disabled rows are
 * ignored. A pinned default (an enabled `isDefault` row) wins outright — the oldest
 * one if somehow several are flagged. Otherwise least window usage wins; ties break by
 * least-recently-leased (nulls first = never leased), then oldest created. Returns null
 * when no enabled row exists.
 */
export function chooseToken<T extends PoolRotationRecord>(
  records: T[],
  now: number,
  windowMs: number,
): T | null {
  const enabled = records.filter((r) => r.enabled)
  const defaults = enabled.filter((r) => r.isDefault)
  if (defaults.length > 0) {
    return defaults.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b))
  }
  let best: T | null = null
  let bestUsage = Number.POSITIVE_INFINITY
  for (const record of enabled) {
    const usage = windowUsage(record, now, windowMs)
    if (best === null || usage < bestUsage || (usage === bestUsage && isFresher(record, best))) {
      best = record
      bestUsage = usage
    }
  }
  return best
}

// Tiebreak: a row never leased (lastUsedAt null) is preferred; otherwise the
// one leased longest ago; otherwise the one created first.
function isFresher(candidate: PoolRotationRecord, current: PoolRotationRecord): boolean {
  const a = candidate.lastUsedAt
  const b = current.lastUsedAt
  if (a !== b) {
    if (a == null) return true
    if (b == null) return false
    return a < b
  }
  return candidate.createdAt < current.createdAt
}

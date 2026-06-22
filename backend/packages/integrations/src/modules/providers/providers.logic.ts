// Pure rotation logic for usage-aware credential pools (subscription tokens AND
// direct-provider API keys), kept separate from the services so it can be
// unit-tested without a repository. The policy is usage-aware: prefer the row
// that has consumed the fewest tokens in the current rolling window, falling back
// to least-recently-leased (round-robin) and then oldest-created for ties and
// cold-start rows.

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
}

/** Default rolling usage window (~5h) — mirrors subscription quota windows. */
export const DEFAULT_USAGE_WINDOW_MS = 5 * 60 * 60 * 1000

/** Effective window usage for a row: counters reset once the window ages out. */
export function windowUsage(record: PoolRotationRecord, now: number, windowMs: number): number {
  if (record.windowStartedAt == null || now - record.windowStartedAt >= windowMs) return 0
  return record.inputTokens + record.outputTokens
}

/**
 * Choose the next row to lease from a non-empty list of live pool rows.
 * Least window usage wins; ties break by least-recently-leased (nulls first =
 * never leased), then oldest created. Returns null only for an empty list.
 */
export function chooseToken<T extends PoolRotationRecord>(
  records: T[],
  now: number,
  windowMs: number,
): T | null {
  let best: T | null = null
  let bestUsage = Number.POSITIVE_INFINITY
  for (const record of records) {
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

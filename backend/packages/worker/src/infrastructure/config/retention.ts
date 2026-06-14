import type { Env } from '../env'
import { retentionMs } from './utils'

/**
 * Retention windows in milliseconds for the tables that don't self-limit. A
 * window of 0 disables pruning for that table (and, for commits, disables the
 * backfill horizon too). See docs/storage-and-retention.md.
 */
export interface RetentionConfig {
  tokenUsageMs: number
  rateLimitMs: number
  commitMs: number
}

export function loadRetentionConfig(env: Env): RetentionConfig {
  return {
    // ~13 months: generous, since the spend budget only reads the current period.
    tokenUsageMs: retentionMs(env.TOKEN_USAGE_RETENTION_DAYS, 395),
    // Aggressive: pure telemetry whose only consumer cares about recent headroom.
    rateLimitMs: retentionMs(env.GITHUB_RATE_LIMIT_RETENTION_DAYS, 7),
    // Caps the commits projection and bounds the initial backfill to the same age.
    commitMs: retentionMs(env.GITHUB_COMMIT_RETENTION_DAYS, 90),
  }
}

import type { RetentionConfig } from '@cat-factory/server'
import type { Env } from '../env'
import { retentionMs } from './utils'

export type { RetentionConfig }

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

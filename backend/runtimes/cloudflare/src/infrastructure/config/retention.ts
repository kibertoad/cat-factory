import type { RetentionConfig } from '@cat-factory/server'
import type { Env } from '../env'
import { retentionMs } from './utils'

export type { RetentionConfig }

export function loadRetentionConfig(env: Env): RetentionConfig {
  return {
    // ~13 months: generous, since the spend budget only reads the current period.
    tokenUsageMs: retentionMs('TOKEN_USAGE_RETENTION_DAYS', env.TOKEN_USAGE_RETENTION_DAYS, 395),
    // Aggressive: pure telemetry whose only consumer cares about recent headroom.
    rateLimitMs: retentionMs(
      'GITHUB_RATE_LIMIT_RETENTION_DAYS',
      env.GITHUB_RATE_LIMIT_RETENTION_DAYS,
      7,
    ),
    // Caps the commits projection and bounds the initial backfill to the same age.
    commitMs: retentionMs('GITHUB_COMMIT_RETENTION_DAYS', env.GITHUB_COMMIT_RETENTION_DAYS, 90),
    // Heavy (full per-call prompt/response) and only useful for recent debugging,
    // so pruned aggressively — default 3 days.
    llmCallMetricsMs: retentionMs(
      'LLM_CALL_METRICS_RETENTION_DAYS',
      env.LLM_CALL_METRICS_RETENTION_DAYS,
      3,
    ),
    // High-churn provisioning event log (separate D1 db); aggressive default of 14 days.
    provisioningLogMs: retentionMs(
      'PROVISIONING_LOG_RETENTION_DAYS',
      env.PROVISIONING_LOG_RETENTION_DAYS,
      14,
    ),
    // Resolved (acted/dismissed) notifications; generous default of 90 days so the
    // inbox's recent history survives. Open cards are never pruned.
    notificationsMs: retentionMs(
      'NOTIFICATION_RETENTION_DAYS',
      env.NOTIFICATION_RETENTION_DAYS,
      90,
    ),
    // Settled-gate projection behind the dashboard's attempt statistics; one row per gate,
    // so a generous 90 days costs little and covers the longest dashboard window.
    gateOutcomesMs: retentionMs('GATE_OUTCOME_RETENTION_DAYS', env.GATE_OUTCOME_RETENTION_DAYS, 90),
    // The daily run rollup exists to answer questions the raw scan is too expensive for, so
    // it is kept the longest of all (~13 months): a rolled-up day is a handful of tiny rows.
    runDaysMs: retentionMs(
      'PLATFORM_RUN_DAY_RETENTION_DAYS',
      env.PLATFORM_RUN_DAY_RETENTION_DAYS,
      400,
    ),
  }
}

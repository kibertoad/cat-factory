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
    // Heavy (full per-call prompt/response), so the window trades disk against how far back a
    // post-mortem can reach: default 14 days, matching the Node facade. The 3 days it replaced
    // expired the record before most investigations start; a post-mortem that cannot read the
    // calls it is about is the same as no telemetry at all. Set it back to 3 to restore the old
    // footprint on a deployment that also stores bodies.
    llmCallMetricsMs: retentionMs(
      'LLM_CALL_METRICS_RETENTION_DAYS',
      env.LLM_CALL_METRICS_RETENTION_DAYS,
      14,
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
    // The account audit log: the LONGEST window of the lot (~2 years) and its own knob, because
    // it answers a compliance question rather than an operational one — "who changed that" is
    // asked long after anybody stopped watching, and a short window makes the honest answer
    // "we deleted it". Bounded rather than infinite because it is the one table that grows
    // monotonically with run volume; 0 disables the prune for a deployment that exports it.
    auditEventsMs: retentionMs('AUDIT_EVENT_RETENTION_DAYS', env.AUDIT_EVENT_RETENTION_DAYS, 730),
  }
}

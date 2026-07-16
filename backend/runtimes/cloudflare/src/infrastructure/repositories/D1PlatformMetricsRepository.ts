import { agentRunKindSchema } from '@cat-factory/contracts'
import type {
  PlatformDurationStats,
  PlatformFailureCount,
  PlatformLiveCounts,
  PlatformMetricsRepository,
  PlatformRunOutcome,
  PlatformRunTrendPoint,
} from '@cat-factory/kernel'
import { decodeEnum } from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'

// Deployment-level rollups over `agent_runs`, scoped to an account by a sub-select on
// `workspaces` (both live in the main DB). Every method is a single aggregate query —
// no row is loaded to be reduced in JS (the N+1/aggregate ban). Mirrors
// {@link DrizzlePlatformMetricsRepository}; the cross-runtime conformance suite asserts
// the two agree.

/** The account's workspace ids, as a scalar sub-select reused by every windowed query. */
const ACCOUNT_WORKSPACES = 'SELECT id FROM workspaces WHERE account_id = ?'

export class D1PlatformMetricsRepository implements PlatformMetricsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async runOutcomesSince(accountId: string, sinceEpochMs: number): Promise<PlatformRunOutcome[]> {
    const { results } = await this.db
      .prepare(
        `SELECT kind, status, COUNT(*) AS count
         FROM agent_runs
         WHERE workspace_id IN (${ACCOUNT_WORKSPACES}) AND created_at >= ?
         GROUP BY kind, status`,
      )
      .bind(accountId, sinceEpochMs)
      .all<{ kind: string; status: string; count: number }>()
    return (results ?? []).map((r) => ({
      kind: decodeEnum(agentRunKindSchema, r.kind, { table: 'agent_runs', column: 'kind', id: '' }),
      status: r.status,
      count: Number(r.count),
    }))
  }

  async runOutcomeTrend(
    accountId: string,
    sinceEpochMs: number,
    bucketMs: number,
  ): Promise<PlatformRunTrendPoint[]> {
    const { results } = await this.db
      .prepare(
        // CAST(... AS INTEGER) forces integer (floor) division: D1 binds JS numbers as REAL,
        // so a bare `created_at / ?` would be floating-point and never land on a bucket edge.
        `SELECT CAST(created_at / ? AS INTEGER) * ? AS bucket_start, status, COUNT(*) AS count
         FROM agent_runs
         WHERE workspace_id IN (${ACCOUNT_WORKSPACES}) AND created_at >= ?
         GROUP BY bucket_start, status
         ORDER BY bucket_start`,
      )
      .bind(bucketMs, bucketMs, accountId, sinceEpochMs)
      .all<{ bucket_start: number; status: string; count: number }>()
    return (results ?? []).map((r) => ({
      bucketStart: Number(r.bucket_start),
      status: r.status,
      count: Number(r.count),
    }))
  }

  async failureKindBreakdown(
    accountId: string,
    sinceEpochMs: number,
  ): Promise<PlatformFailureCount[]> {
    const { results } = await this.db
      .prepare(
        `SELECT COALESCE(json_extract(failure, '$.kind'), 'unknown') AS failure_kind, COUNT(*) AS count
         FROM agent_runs
         WHERE workspace_id IN (${ACCOUNT_WORKSPACES}) AND created_at >= ? AND status = 'failed'
         GROUP BY failure_kind
         ORDER BY count DESC`,
      )
      .bind(accountId, sinceEpochMs)
      .all<{ failure_kind: string; count: number }>()
    return (results ?? []).map((r) => ({
      failureKind: r.failure_kind ?? 'unknown',
      count: Number(r.count),
    }))
  }

  async activeAndParkedCounts(accountId: string): Promise<PlatformLiveCounts> {
    const { results } = await this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM agent_runs
         WHERE workspace_id IN (${ACCOUNT_WORKSPACES})
           AND status IN ('running', 'blocked', 'paused', 'pending')
         GROUP BY status`,
      )
      .bind(accountId)
      .all<{ status: string; count: number }>()
    const counts: PlatformLiveCounts = { running: 0, blocked: 0, paused: 0, pending: 0 }
    for (const r of results ?? []) {
      if (r.status in counts) counts[r.status as keyof PlatformLiveCounts] = Number(r.count)
    }
    return counts
  }

  async durationStatsSince(
    accountId: string,
    sinceEpochMs: number,
  ): Promise<PlatformDurationStats> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                AVG(updated_at - created_at) AS avg_ms,
                MIN(updated_at - created_at) AS min_ms,
                MAX(updated_at - created_at) AS max_ms
         FROM agent_runs
         WHERE workspace_id IN (${ACCOUNT_WORKSPACES}) AND created_at >= ?
           AND status IN ('done', 'failed')`,
      )
      .bind(accountId, sinceEpochMs)
      .first<{
        count: number
        avg_ms: number | null
        min_ms: number | null
        max_ms: number | null
      }>()
    const count = Number(row?.count ?? 0)
    return {
      count,
      avgMs: count > 0 && row?.avg_ms != null ? Math.round(Number(row.avg_ms)) : null,
      minMs: count > 0 && row?.min_ms != null ? Number(row.min_ms) : null,
      maxMs: count > 0 && row?.max_ms != null ? Number(row.max_ms) : null,
    }
  }
}

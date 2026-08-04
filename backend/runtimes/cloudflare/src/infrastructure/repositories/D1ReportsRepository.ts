import type { ReportActivityDimension, ReportSpendDimension } from '@cat-factory/contracts'
import type {
  ReportActivityGroup,
  ReportRange,
  ReportScope,
  ReportSpendGroup,
  ReportSpendTrendBucket,
  ReportsRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// Cross-cutting usage-analytics rollups over `token_usage` and `agent_runs`, scoped to an
// account by the same `workspaces` sub-select the platform-metrics repo uses (every table
// touched here lives in the main DB — the telemetry database is never joined). Each method
// is a single aggregate query; no row is loaded to be reduced in JS (the N+1/aggregate
// ban). Mirrors {@link DrizzleReportsRepository}; the cross-runtime conformance suite
// asserts the two agree.

/** The account's workspace ids, as a scalar sub-select reused by every query. */
const ACCOUNT_WORKSPACES = 'SELECT id FROM workspaces WHERE account_id = ?'

/**
 * A service's display name, PRE-AGGREGATED to exactly one row per service id.
 *
 * `blocks` is keyed `(workspace_id, id)` and a block id is only unique WITHIN a workspace —
 * which is why `idx_services_frame` is scoped by account rather than globally, and why a
 * seeded/templated frame id legitimately recurs across an account's boards. Joining
 * `blocks ON blocks.id = services.frame_block_id` directly from an aggregate would therefore
 * FAN OUT: one ledger row would match N blocks and multiply that service's calls, tokens and
 * cost by N, leaving the service breakdown disagreeing with the window totals. Grouping the
 * title down to one row per service first makes the join provably 1:1, so the numbers are
 * immune no matter how many boards share the id.
 *
 * `MIN(title)` still picks arbitrarily among colliding blocks. That ambiguity is confined to
 * the LABEL, which is cosmetic; the aggregates it used to corrupt are not. `services` holds
 * one row per service frame, so materialising this is cheap.
 */
const SERVICE_LABELS = `SELECT s.id AS service_id, MIN(b.title) AS title
                        FROM services s
                        LEFT JOIN blocks b ON b.id = s.frame_block_id
                        GROUP BY s.id`

/**
 * The tracker ticket a block is linked to, PRE-AGGREGATED to exactly one row per
 * `(workspace_id, linked_block_id)`.
 *
 * `idx_tasks_block` is a plain index, not a unique one: a block can legitimately be linked from
 * more than one imported issue (two sources, or a re-imported duplicate). Joining `tasks`
 * straight into an aggregate would then FAN OUT, multiplying that block's calls, tokens and cost
 * by the number of tickets pointing at it and leaving the ticket breakdown disagreeing with the
 * window totals. The same trap `SERVICE_LABELS` exists for.
 *
 * `MIN(source || ':' || external_id)` makes the attribution DETERMINISTIC (the lowest ref wins)
 * rather than arbitrary. Splitting a block's cost across its tickets would be worse: the halves
 * would answer no question anyone asked, and summing the breakdown would still be right only by
 * accident. A multi-linked block therefore reports under one of its tickets, and the totals stay
 * exact.
 *
 * The ticket's TITLE is deliberately not carried out of here. A second `MIN` over a different
 * column is not guaranteed to come from the same row as the first, so a multi-linked block could
 * render one ticket's title beside another's ref: a label that is not merely arbitrary but
 * WRONG. The `source:externalId` ref is self-describing (`jira:PROJ-412`), so the dimension does
 * what `model` and `taskType` do and reports no label at all.
 */
const TICKET_BY_BLOCK = `SELECT workspace_id, linked_block_id,
                                MIN(source || ':' || external_id) AS ticket_key
                         FROM tasks
                         WHERE linked_block_id IS NOT NULL AND deleted_at IS NULL
                         GROUP BY workspace_id, linked_block_id`

/**
 * The joins and grouped key/label a spend dimension needs. `service` and `taskType` reach
 * the call's run through `execution_id` (a metered call records the run, not the board
 * shape), so a call with no resolvable run falls into the `''` (unattributed) bucket
 * rather than vanishing from the report.
 */
const SPEND_DIMENSIONS: Record<
  ReportSpendDimension,
  { joins: string; key: string; label: string }
> = {
  model: { joins: '', key: "tu.provider || ':' || tu.model", label: 'NULL' },
  agentKind: { joins: '', key: 'tu.agent_kind', label: 'NULL' },
  workspace: {
    joins: 'LEFT JOIN workspaces w ON w.id = tu.workspace_id',
    key: 'tu.workspace_id',
    label: 'MAX(w.name)',
  },
  service: {
    joins: `LEFT JOIN agent_runs ar ON ar.workspace_id = tu.workspace_id AND ar.id = tu.execution_id
            LEFT JOIN (${SERVICE_LABELS}) sl ON sl.service_id = ar.service_id`,
    key: "COALESCE(ar.service_id, '')",
    label: 'MAX(sl.title)',
  },
  taskType: {
    joins: `LEFT JOIN agent_runs ar ON ar.workspace_id = tu.workspace_id AND ar.id = tu.execution_id
            LEFT JOIN blocks b ON b.workspace_id = ar.workspace_id AND b.id = ar.block_id`,
    key: "COALESCE(b.task_type, '')",
    label: 'NULL',
  },
  repo: {
    // `services.id` is a primary key and `(workspace_id, github_id)` is `github_repos`'
    // primary key, so both joins are provably 1:1 and cannot fan the aggregate out. The KEY
    // comes off the service (which always knows its repo id) and the LABEL off the projection
    // (which the run's workspace may not hold a row in), so an unsynced repo loses its name
    // and keeps its money.
    joins: `LEFT JOIN agent_runs ar ON ar.workspace_id = tu.workspace_id AND ar.id = tu.execution_id
            LEFT JOIN services s ON s.id = ar.service_id
            LEFT JOIN github_repos gr ON gr.workspace_id = tu.workspace_id
                                     AND gr.github_id = s.repo_github_id`,
    key: "COALESCE(CAST(s.repo_github_id AS TEXT), '')",
    label: "MAX(gr.owner || '/' || gr.name)",
  },
  ticket: {
    joins: `LEFT JOIN agent_runs ar ON ar.workspace_id = tu.workspace_id AND ar.id = tu.execution_id
            LEFT JOIN (${TICKET_BY_BLOCK}) tk ON tk.workspace_id = ar.workspace_id
                                             AND tk.linked_block_id = ar.block_id`,
    key: "COALESCE(tk.ticket_key, '')",
    label: 'NULL',
  },
}

/** The same, for the run-based activity breakdowns (a run already carries its service/block). */
const ACTIVITY_DIMENSIONS: Record<
  ReportActivityDimension,
  { joins: string; key: string; label: string }
> = {
  workspace: {
    joins: 'LEFT JOIN workspaces w ON w.id = ar.workspace_id',
    key: 'ar.workspace_id',
    label: 'MAX(w.name)',
  },
  service: {
    joins: `LEFT JOIN (${SERVICE_LABELS}) sl ON sl.service_id = ar.service_id`,
    key: "COALESCE(ar.service_id, '')",
    label: 'MAX(sl.title)',
  },
  taskType: {
    joins: 'LEFT JOIN blocks b ON b.workspace_id = ar.workspace_id AND b.id = ar.block_id',
    key: "COALESCE(b.task_type, '')",
    label: 'NULL',
  },
}

/**
 * The metered/subscription cost split. Anything that is not literally `'subscription'`
 * counts as metered, matching how the row decoders widen the column — so an unexpected
 * value is priced as real spend rather than silently discounted to zero.
 */
const METERED_COST =
  "COALESCE(SUM(CASE WHEN tu.billing = 'subscription' THEN 0 ELSE tu.cost_estimate END), 0)"
const SUBSCRIPTION_COST =
  "COALESCE(SUM(CASE WHEN tu.billing = 'subscription' THEN tu.cost_estimate ELSE 0 END), 0)"

interface SpendRow {
  k: string | null
  label: string | null
  input_tokens: number
  output_tokens: number
  calls: number
  metered_cost: number
  subscription_cost: number
}

export class D1ReportsRepository implements ReportsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  /**
   * The account (+ optional single-workspace) scope and the half-open window, as a SQL
   * fragment plus its binds in order. `alias` is the aliased table carrying `workspace_id`
   * and `created_at`, so both the ledger and the run queries share one predicate.
   */
  private scopeClause(
    alias: string,
    scope: ReportScope,
    range: ReportRange,
  ): { sql: string; binds: unknown[] } {
    const binds: unknown[] = [scope.accountId]
    let sql = `${alias}.workspace_id IN (${ACCOUNT_WORKSPACES})`
    if (scope.workspaceId) {
      sql += ` AND ${alias}.workspace_id = ?`
      binds.push(scope.workspaceId)
    }
    sql += ` AND ${alias}.created_at >= ? AND ${alias}.created_at < ?`
    binds.push(range.since, range.until)
    return { sql, binds }
  }

  async spendByDimension(
    scope: ReportScope,
    dimension: ReportSpendDimension,
    range: ReportRange,
  ): Promise<ReportSpendGroup[]> {
    const dim = SPEND_DIMENSIONS[dimension]
    const where = this.scopeClause('tu', scope, range)
    const { results } = await this.db
      .prepare(
        `SELECT ${dim.key} AS k,
                ${dim.label} AS label,
                COALESCE(SUM(tu.input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(tu.output_tokens), 0) AS output_tokens,
                COUNT(*)                           AS calls,
                ${METERED_COST}                    AS metered_cost,
                ${SUBSCRIPTION_COST}               AS subscription_cost
         FROM token_usage tu
         ${dim.joins}
         WHERE ${where.sql}
         GROUP BY k
         ORDER BY (metered_cost + subscription_cost) DESC, k`,
      )
      .bind(...where.binds)
      .all<SpendRow>()
    return (results ?? []).map((r) => ({
      key: r.k ?? '',
      label: r.label,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      calls: Number(r.calls),
      meteredCost: Number(r.metered_cost),
      subscriptionCost: Number(r.subscription_cost),
    }))
  }

  async activityByDimension(
    scope: ReportScope,
    dimension: ReportActivityDimension,
    range: ReportRange,
  ): Promise<ReportActivityGroup[]> {
    const dim = ACTIVITY_DIMENSIONS[dimension]
    const where = this.scopeClause('ar', scope, range)
    // The status splits AND the terminal-run mean duration are conditional aggregates over
    // the SAME pass — AVG skips the NULLs a non-terminal run contributes, so no second scan.
    const { results } = await this.db
      .prepare(
        `SELECT ${dim.key} AS k,
                ${dim.label} AS label,
                COUNT(*) AS runs,
                SUM(CASE WHEN ar.status = 'done' THEN 1 ELSE 0 END)    AS done,
                SUM(CASE WHEN ar.status = 'failed' THEN 1 ELSE 0 END)  AS failed,
                SUM(CASE WHEN ar.status = 'running' THEN 1 ELSE 0 END) AS running,
                SUM(CASE WHEN ar.status IN ('done', 'failed', 'running') THEN 0 ELSE 1 END) AS other,
                AVG(CASE WHEN ar.status IN ('done', 'failed')
                         THEN ar.updated_at - ar.created_at END) AS avg_duration_ms
         FROM agent_runs ar
         ${dim.joins}
         WHERE ${where.sql}
         GROUP BY k
         ORDER BY runs DESC, k`,
      )
      .bind(...where.binds)
      .all<{
        k: string | null
        label: string | null
        runs: number
        done: number
        failed: number
        running: number
        other: number
        avg_duration_ms: number | null
      }>()
    return (results ?? []).map((r) => ({
      key: r.k ?? '',
      label: r.label,
      runs: Number(r.runs),
      done: Number(r.done),
      failed: Number(r.failed),
      running: Number(r.running),
      other: Number(r.other),
      avgDurationMs: r.avg_duration_ms == null ? null : Math.round(Number(r.avg_duration_ms)),
    }))
  }

  async spendTrend(
    scope: ReportScope,
    range: ReportRange,
    bucketMs: number,
  ): Promise<ReportSpendTrendBucket[]> {
    const where = this.scopeClause('tu', scope, range)
    // CAST(... AS INTEGER) forces integer (floor) division: D1 binds JS numbers as REAL,
    // so a bare `created_at / ?` would be floating-point and never land on a bucket edge.
    const { results } = await this.db
      .prepare(
        `SELECT CAST(tu.created_at / ? AS INTEGER) * ? AS bucket_start,
                COALESCE(SUM(tu.input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(tu.output_tokens), 0) AS output_tokens,
                COUNT(*)                           AS calls,
                ${METERED_COST}                    AS metered_cost,
                ${SUBSCRIPTION_COST}               AS subscription_cost
         FROM token_usage tu
         WHERE ${where.sql}
         GROUP BY bucket_start
         ORDER BY bucket_start`,
      )
      .bind(bucketMs, bucketMs, ...where.binds)
      .all<{
        bucket_start: number
        input_tokens: number
        output_tokens: number
        calls: number
        metered_cost: number
        subscription_cost: number
      }>()
    return (results ?? []).map((r) => ({
      bucketStart: Number(r.bucket_start),
      meteredCost: Number(r.metered_cost),
      subscriptionCost: Number(r.subscription_cost),
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    }))
  }
}

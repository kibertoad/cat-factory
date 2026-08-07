import type { ReportSpendDimension } from '@cat-factory/contracts'
import {
  SPEND_DAYS_ROLLUP,
  type ReportRange,
  type ReportScope,
  type ReportSpendGroup,
  type ReportSpendTrendBucket,
  type SpendRollupRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// The durable cost-attribution rollup (`spend_days`) against D1: the write is one
// `INSERT … SELECT … GROUP BY` folding the ledger with the run's board shape frozen onto it,
// and every read is one aggregate over that table ALONE, with no join, so nothing a reader sees
// can be re-pointed or pruned out from under it. Mirrors `DrizzleSpendRollupRepository`; the
// cross-runtime conformance suite asserts the two agree with each other AND with the
// ledger-side `ReportsRepository` they stand in for on the long windows.

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A service's display name, PRE-AGGREGATED to one row per service id, the same guard the
 * ledger-side repository documents at length: `blocks` is keyed `(workspace_id, id)`, a block
 * id is only unique within a board, so joining `blocks ON blocks.id = services.frame_block_id`
 * from an aggregate would FAN OUT and multiply that service's calls, tokens and cost.
 */
const SERVICE_LABELS = `SELECT s.id AS service_id, MIN(b.title) AS title
                        FROM services s
                        LEFT JOIN blocks b ON b.id = s.frame_block_id
                        GROUP BY s.id`

/**
 * The tracker ticket a block is linked to, PRE-AGGREGATED to one row per
 * `(workspace_id, linked_block_id)`: `idx_tasks_block` is a plain index, so a block linked
 * from two imported issues would otherwise fan the aggregate out and double that block's
 * money. `MIN(source || ':' || external_id)` makes the pick deterministic, matching the
 * ledger-side dimension exactly. The rollup must not attribute a block to a different ticket
 * than the live read would, or the two sources would disagree at the window boundary.
 */
const TICKET_BY_BLOCK = `SELECT workspace_id, linked_block_id,
                                MIN(source || ':' || external_id) AS ticket_key
                         FROM tasks
                         WHERE linked_block_id IS NOT NULL AND deleted_at IS NULL
                         GROUP BY workspace_id, linked_block_id`

/**
 * Every join the fold needs, each provably 1:1 with a ledger row: `workspaces` and `services`
 * on their primary keys, `blocks` and `github_repos` on theirs, and the two pre-aggregated
 * sub-selects above. That is what lets `COUNT(*)` and the token/cost sums stay exact while
 * seven tables are in the query.
 */
const ROLLUP_JOINS = `LEFT JOIN workspaces w ON w.id = tu.workspace_id
   LEFT JOIN agent_runs ar ON ar.workspace_id = tu.workspace_id AND ar.id = tu.execution_id
   LEFT JOIN blocks b ON b.workspace_id = ar.workspace_id AND b.id = ar.block_id
   LEFT JOIN services s ON s.id = ar.service_id
   LEFT JOIN (${SERVICE_LABELS}) sl ON sl.service_id = ar.service_id
   LEFT JOIN github_repos gr ON gr.workspace_id = tu.workspace_id
                            AND gr.github_id = s.repo_github_id
   LEFT JOIN (${TICKET_BY_BLOCK}) tk ON tk.workspace_id = ar.workspace_id
                                    AND tk.linked_block_id = ar.block_id`

/**
 * The two cost sums, spelled out rather than referenced by output alias.
 *
 * The alias would be `metered_cost`, which is also the name of the COLUMN being summed, and
 * inside an aggregate query SQLite resolves a bare name in an ORDER BY expression to the input
 * column: the ranking then read one arbitrary row's cost per group instead of the group's
 * total, which silently mis-ordered "heaviest first", the one thing every breakdown promises.
 */
const METERED_COST = 'COALESCE(SUM(sd.metered_cost), 0)'
const SUBSCRIPTION_COST = 'COALESCE(SUM(sd.subscription_cost), 0)'

/** Which stored column a spend dimension groups by, and which one labels it. */
const DIMENSIONS: Record<ReportSpendDimension, { key: string; label: string }> = {
  model: { key: "sd.provider || ':' || sd.model", label: 'NULL' },
  agentKind: { key: 'sd.agent_kind', label: 'NULL' },
  workspace: { key: 'sd.workspace_id', label: 'MAX(sd.workspace_name)' },
  service: { key: 'sd.service_id', label: 'MAX(sd.service_name)' },
  taskType: { key: 'sd.task_type', label: 'NULL' },
  repo: { key: 'sd.repo_id', label: 'MAX(sd.repo_name)' },
  ticket: { key: 'sd.ticket_ref', label: 'NULL' },
  run: { key: 'sd.execution_id', label: 'MAX(sd.block_title)' },
}

interface SpendRow {
  k: string | null
  label: string | null
  input_tokens: number
  output_tokens: number
  calls: number
  metered_cost: number
  subscription_cost: number
}

export class D1SpendRollupRepository implements SpendRollupRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async rollupSpendDays(fromEpochMs: number, toEpochMs: number): Promise<number> {
    // Snap to day edges so a partially-covered day is never written with only the covered
    // part's spend, which would then read as a complete (and cheap) day.
    const from = Math.floor(fromEpochMs / DAY_MS) * DAY_MS
    const to = Math.ceil(toEpochMs / DAY_MS) * DAY_MS
    if (to <= from) return 0
    // DELETE the window, then INSERT it: an upsert alone is NOT a rewrite. A ledger row can
    // arrive for a day that has already been rolled up (a run still in flight, a late meter),
    // and a bucket the new result set no longer produces (a run whose block was since
    // deleted, so its `taskType` moves to the unattributed slice) is never touched by
    // `DO UPDATE` and would sit there double-counting for the LIFE of the table, which here
    // means forever. `batch()` runs both in one implicit transaction, so a concurrent report
    // read never observes the window mid-rewrite and renders the gap as a quiet fortnight.
    const [, inserted] = await this.db.batch([
      this.db
        .prepare('DELETE FROM spend_days WHERE day_start >= ? AND day_start < ?')
        .bind(from, to),
      this.db
        .prepare(
          `INSERT INTO spend_days (
             workspace_id, day_start, execution_id, agent_kind, provider, model, billing, vendor,
             account_id, workspace_name, block_id, block_title, service_id, service_name,
             repo_id, repo_name, task_type, ticket_ref,
             calls, input_tokens, output_tokens, metered_cost, subscription_cost)
           SELECT tu.workspace_id,
                  CAST(tu.created_at / ? AS INTEGER) * ? AS day_start,
                  COALESCE(tu.execution_id, '') AS execution_id,
                  tu.agent_kind,
                  tu.provider,
                  tu.model,
                  tu.billing,
                  COALESCE(tu.vendor, '') AS vendor,
                  -- The ledger's own denormalized account wins; the board's is the fallback
                  -- for a row recorded before it was resolved.
                  MAX(COALESCE(tu.account_id, w.account_id, '')) AS account_id,
                  MAX(w.name) AS workspace_name,
                  MAX(COALESCE(ar.block_id, '')) AS block_id,
                  MAX(b.title) AS block_title,
                  MAX(COALESCE(ar.service_id, '')) AS service_id,
                  MAX(sl.title) AS service_name,
                  MAX(COALESCE(CAST(s.repo_github_id AS TEXT), '')) AS repo_id,
                  MAX(gr.owner || '/' || gr.name) AS repo_name,
                  MAX(COALESCE(b.task_type, '')) AS task_type,
                  MAX(COALESCE(tk.ticket_key, '')) AS ticket_ref,
                  COUNT(*) AS calls,
                  COALESCE(SUM(tu.input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(tu.output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(CASE WHEN tu.billing = 'subscription'
                                    THEN 0 ELSE tu.cost_estimate END), 0) AS metered_cost,
                  COALESCE(SUM(CASE WHEN tu.billing = 'subscription'
                                    THEN tu.cost_estimate ELSE 0 END), 0) AS subscription_cost
           FROM token_usage tu
           ${ROLLUP_JOINS}
           WHERE tu.created_at >= ? AND tu.created_at < ?
           GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
           ON CONFLICT(workspace_id, day_start, execution_id, agent_kind, provider, model,
                       billing, vendor)
             DO UPDATE SET calls = excluded.calls,
                           input_tokens = excluded.input_tokens,
                           output_tokens = excluded.output_tokens,
                           metered_cost = excluded.metered_cost,
                           subscription_cost = excluded.subscription_cost`,
        )
        .bind(DAY_MS, DAY_MS, from, to),
      // The sweep's coverage, in the SAME batch (hence the same transaction) as the rewrite it
      // describes, and forward-only so a catch-up pass over an older window cannot present a
      // current rollup as a stalled one. `through_day` is the last day actually covered.
      this.db
        .prepare(
          `INSERT INTO platform_rollup_state (rollup, through_day, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(rollup) DO UPDATE SET
             through_day = MAX(platform_rollup_state.through_day, excluded.through_day),
             updated_at = MAX(platform_rollup_state.updated_at, excluded.updated_at)`,
        )
        .bind(SPEND_DAYS_ROLLUP, to - DAY_MS, toEpochMs),
    ])
    return inserted?.meta.changes ?? 0
  }

  async spendRollupWatermark(): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT through_day FROM platform_rollup_state WHERE rollup = ?')
      .bind(SPEND_DAYS_ROLLUP)
      .first<{ through_day: number }>()
    return row ? Number(row.through_day) : null
  }

  /**
   * The account (+ optional single-board) scope and the day window. Scoped on the row's OWN
   * `account_id` rather than a `workspaces` sub-select: the whole point of the table is that
   * a read of it does not depend on rows that may since have been re-pointed or deleted.
   */
  private scopeClause(scope: ReportScope, range: ReportRange): { sql: string; binds: unknown[] } {
    const binds: unknown[] = [scope.accountId]
    let sql = 'sd.account_id = ?'
    if (scope.workspaceId) {
      sql += ' AND sd.workspace_id = ?'
      binds.push(scope.workspaceId)
    }
    sql += ' AND sd.day_start >= ? AND sd.day_start < ?'
    binds.push(range.since, range.until)
    return { sql, binds }
  }

  async spendByDimension(
    scope: ReportScope,
    dimension: ReportSpendDimension,
    range: ReportRange,
  ): Promise<ReportSpendGroup[]> {
    const dim = DIMENSIONS[dimension]
    const where = this.scopeClause(scope, range)
    const { results } = await this.db
      .prepare(
        `SELECT ${dim.key} AS k,
                ${dim.label} AS label,
                COALESCE(SUM(sd.input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(sd.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(sd.calls), 0)         AS calls,
                ${METERED_COST}                    AS metered_cost,
                ${SUBSCRIPTION_COST}               AS subscription_cost
         FROM spend_days sd
         WHERE ${where.sql}
         GROUP BY k
         ORDER BY (${METERED_COST} + ${SUBSCRIPTION_COST}) DESC, k`,
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

  async spendTrend(
    scope: ReportScope,
    range: ReportRange,
    bucketMs: number,
  ): Promise<ReportSpendTrendBucket[]> {
    const where = this.scopeClause(scope, range)
    // CAST(... AS INTEGER) forces integer (floor) division: D1 binds JS numbers as REAL, so a
    // bare `day_start / ?` would be floating-point and never land on a bucket edge.
    const { results } = await this.db
      .prepare(
        `SELECT CAST(sd.day_start / ? AS INTEGER) * ? AS bucket_start,
                COALESCE(SUM(sd.input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(sd.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(sd.calls), 0)         AS calls,
                ${METERED_COST}                    AS metered_cost,
                ${SUBSCRIPTION_COST}               AS subscription_cost
         FROM spend_days sd
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

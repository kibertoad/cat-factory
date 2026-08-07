// The durable cost-attribution rollup (`spend_days`) against Postgres: the write is one
// `INSERT … SELECT … GROUP BY` folding the ledger with the run's board shape frozen onto it,
// and every read is one aggregate over that table ALONE, with no join, so nothing a reader sees
// can be re-pointed or pruned out from under it. Mirrors `D1SpendRollupRepository`; the
// cross-runtime conformance suite asserts the two agree with each other AND with the
// ledger-side `ReportsRepository` they stand in for on the long windows.

import type { ReportSpendDimension } from '@cat-factory/contracts'
import {
  SPEND_DAYS_ROLLUP,
  type ReportRange,
  type ReportScope,
  type ReportSpendGroup,
  type ReportSpendTrendBucket,
  type SpendRollupRepository,
} from '@cat-factory/kernel'
import { type SQL, and, eq, gte, lt, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { platformRollupState, spendDays } from '../../db/schema.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Which stored column a spend dimension groups by, and which one labels it. */
function keyAndLabel(dimension: ReportSpendDimension): {
  key: SQL<string>
  label: SQL<string | null>
} {
  const noLabel = sql<string | null>`null::text`
  switch (dimension) {
    case 'model':
      return {
        key: sql<string>`(${spendDays.provider} || ':' || ${spendDays.model})`,
        label: noLabel,
      }
    case 'agentKind':
      return { key: sql<string>`${spendDays.agent_kind}`, label: noLabel }
    case 'workspace':
      return {
        key: sql<string>`${spendDays.workspace_id}`,
        label: sql<string | null>`max(${spendDays.workspace_name})`,
      }
    case 'service':
      return {
        key: sql<string>`${spendDays.service_id}`,
        label: sql<string | null>`max(${spendDays.service_name})`,
      }
    case 'taskType':
      return { key: sql<string>`${spendDays.task_type}`, label: noLabel }
    case 'repo':
      return {
        key: sql<string>`${spendDays.repo_id}`,
        label: sql<string | null>`max(${spendDays.repo_name})`,
      }
    case 'ticket':
      return { key: sql<string>`${spendDays.ticket_ref}`, label: noLabel }
    case 'run':
      return {
        key: sql<string>`${spendDays.execution_id}`,
        label: sql<string | null>`max(${spendDays.block_title})`,
      }
  }
}

const meteredCost = sql<number>`coalesce(sum(${spendDays.metered_cost}), 0)::float8`
const subscriptionCost = sql<number>`coalesce(sum(${spendDays.subscription_cost}), 0)::float8`

export class DrizzleSpendRollupRepository implements SpendRollupRepository {
  constructor(private readonly db: DrizzleDb) {}

  async rollupSpendDays(fromEpochMs: number, toEpochMs: number): Promise<number> {
    // The aggregation happens in Postgres and no ledger row is loaded. Bounds snap to day
    // edges so a partially-covered day is never written with only the covered part's spend,
    // which would then read as a complete (and cheap) day.
    const from = Math.floor(fromEpochMs / DAY_MS) * DAY_MS
    const to = Math.ceil(toEpochMs / DAY_MS) * DAY_MS
    if (to <= from) return 0
    // DELETE the window, then INSERT it: an upsert alone is NOT a rewrite. A ledger row can
    // arrive for a day that has already been rolled up (a run still in flight, a late meter),
    // and a bucket the new result set no longer produces (a run whose block was since
    // deleted, so its `taskType` moves to the unattributed slice) is never touched by
    // `DO UPDATE` and would sit there double-counting for the LIFE of the table, which here
    // means forever. Both statements ride ONE transaction, so a concurrent report read never
    // observes the window mid-rewrite and renders the gap as a quiet fortnight.
    //
    // Every join below is provably 1:1 with a ledger row: `workspaces`, `services`, `blocks`
    // and `github_repos` on their primary keys, and the two sub-selects pre-aggregated to one
    // row per service / per `(workspace, block)` for the same fan-out reason the ledger-side
    // repository documents. That is what keeps `count(*)` and the sums exact across seven
    // tables. The ticket pick (`min(source:externalId)`) matches the ledger-side dimension
    // exactly: the two sources must not attribute one block to different tickets, or they
    // would disagree across the window boundary that routes between them.
    return await this.db.transaction(async (tx) => {
      await tx
        .delete(spendDays)
        .where(and(gte(spendDays.day_start, from), lt(spendDays.day_start, to)))
      const res = await tx.execute(sql`
        INSERT INTO spend_days (
          workspace_id, day_start, execution_id, agent_kind, provider, model, billing, vendor,
          account_id, workspace_name, block_id, block_title, service_id, service_name,
          repo_id, repo_name, task_type, ticket_ref,
          calls, input_tokens, output_tokens, metered_cost, subscription_cost)
        SELECT tu.workspace_id,
               (tu.created_at / ${DAY_MS}::bigint) * ${DAY_MS}::bigint AS day_start,
               coalesce(tu.execution_id, '') AS execution_id,
               tu.agent_kind,
               tu.provider,
               tu.model,
               tu.billing,
               coalesce(tu.vendor, '') AS vendor,
               -- The ledger's own denormalized account wins; the board's is the fallback for a
               -- row recorded before it was resolved.
               max(coalesce(tu.account_id, w.account_id, '')) AS account_id,
               max(w.name) AS workspace_name,
               max(coalesce(ar.block_id, '')) AS block_id,
               max(b.title) AS block_title,
               max(coalesce(ar.service_id, '')) AS service_id,
               max(sl.title) AS service_name,
               max(coalesce(s.repo_github_id::text, '')) AS repo_id,
               max(gr.owner || '/' || gr.name) AS repo_name,
               max(coalesce(b.task_type, '')) AS task_type,
               max(coalesce(tk.ticket_key, '')) AS ticket_ref,
               count(*)::int AS calls,
               coalesce(sum(tu.input_tokens), 0)::bigint AS input_tokens,
               coalesce(sum(tu.output_tokens), 0)::bigint AS output_tokens,
               coalesce(sum(case when tu.billing = 'subscription'
                                 then 0 else tu.cost_estimate end), 0)::float8 AS metered_cost,
               coalesce(sum(case when tu.billing = 'subscription'
                                 then tu.cost_estimate else 0 end), 0)::float8
                 AS subscription_cost
        FROM token_usage tu
        LEFT JOIN workspaces w ON w.id = tu.workspace_id
        LEFT JOIN agent_runs ar ON ar.workspace_id = tu.workspace_id AND ar.id = tu.execution_id
        LEFT JOIN blocks b ON b.workspace_id = ar.workspace_id AND b.id = ar.block_id
        LEFT JOIN services s ON s.id = ar.service_id
        LEFT JOIN (SELECT s2.id AS service_id, min(b2.title) AS title
                   FROM services s2
                   LEFT JOIN blocks b2 ON b2.id = s2.frame_block_id
                   GROUP BY s2.id) sl ON sl.service_id = ar.service_id
        LEFT JOIN github_repos gr ON gr.workspace_id = tu.workspace_id
                                 AND gr.github_id = s.repo_github_id
        LEFT JOIN (SELECT workspace_id, linked_block_id,
                          min(source || ':' || external_id) AS ticket_key
                   FROM tasks
                   WHERE linked_block_id IS NOT NULL AND deleted_at IS NULL
                   GROUP BY workspace_id, linked_block_id) tk
               ON tk.workspace_id = ar.workspace_id AND tk.linked_block_id = ar.block_id
        WHERE tu.created_at >= ${from} AND tu.created_at < ${to}
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
        ON CONFLICT (workspace_id, day_start, execution_id, agent_kind, provider, model,
                     billing, vendor)
          DO UPDATE SET calls = excluded.calls,
                        input_tokens = excluded.input_tokens,
                        output_tokens = excluded.output_tokens,
                        metered_cost = excluded.metered_cost,
                        subscription_cost = excluded.subscription_cost
      `)
      // The sweep's coverage, recorded INSIDE the same transaction as the rewrite it
      // describes, and forward-only so a catch-up pass over an older window cannot present a
      // current rollup as a stalled one. `through_day` is the last day actually covered.
      await tx
        .insert(platformRollupState)
        .values({ rollup: SPEND_DAYS_ROLLUP, through_day: to - DAY_MS, updated_at: toEpochMs })
        .onConflictDoUpdate({
          target: platformRollupState.rollup,
          set: {
            through_day: sql`greatest(${platformRollupState.through_day}, ${to - DAY_MS})`,
            updated_at: sql`greatest(${platformRollupState.updated_at}, ${toEpochMs})`,
          },
        })
      return Number(res.rowCount ?? 0)
    })
  }

  async spendRollupWatermark(): Promise<number | null> {
    const [row] = await this.db
      .select({ throughDay: platformRollupState.through_day })
      .from(platformRollupState)
      .where(eq(platformRollupState.rollup, SPEND_DAYS_ROLLUP))
      .limit(1)
    return row ? Number(row.throughDay) : null
  }

  /**
   * The account (+ optional single-board) scope and the day window. Scoped on the row's OWN
   * `account_id` rather than a `workspaces` sub-select: the whole point of the table is that a
   * read of it does not depend on rows that may since have been re-pointed or deleted.
   */
  private scopeWhere(scope: ReportScope, range: ReportRange) {
    return and(
      eq(spendDays.account_id, scope.accountId),
      scope.workspaceId ? eq(spendDays.workspace_id, scope.workspaceId) : undefined,
      gte(spendDays.day_start, range.since),
      lt(spendDays.day_start, range.until),
    )
  }

  async spendByDimension(
    scope: ReportScope,
    dimension: ReportSpendDimension,
    range: ReportRange,
  ): Promise<ReportSpendGroup[]> {
    const { key, label } = keyAndLabel(dimension)
    // Alias the key expression and GROUP BY / ORDER BY the ALIAS: Drizzle re-emits an inline
    // `sql` expression with fresh bind-parameter placeholders per clause, and Postgres matches
    // GROUP BY columns by parse-tree identity, so the raw fragment would read as a different
    // expression (error 42803). Same trap the ledger-side breakdown documents.
    const rows = await this.db
      .select({
        k: key.as('k'),
        label,
        inputTokens: sql<string>`coalesce(sum(${spendDays.input_tokens}), 0)::bigint`,
        outputTokens: sql<string>`coalesce(sum(${spendDays.output_tokens}), 0)::bigint`,
        calls: sql<string>`coalesce(sum(${spendDays.calls}), 0)::bigint`,
        meteredCost,
        subscriptionCost,
      })
      .from(spendDays)
      .where(this.scopeWhere(scope, range))
      .groupBy(sql`k`)
      .orderBy(sql`(${meteredCost} + ${subscriptionCost}) desc`, sql`k`)
    return rows.map((r) => ({
      key: r.k ?? '',
      label: r.label ?? null,
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      calls: Number(r.calls ?? 0),
      meteredCost: r.meteredCost ?? 0,
      subscriptionCost: r.subscriptionCost ?? 0,
    }))
  }

  async spendTrend(
    scope: ReportScope,
    range: ReportRange,
    bucketMs: number,
  ): Promise<ReportSpendTrendBucket[]> {
    const bucket =
      sql<number>`((${spendDays.day_start} / ${bucketMs}::bigint) * ${bucketMs}::bigint)`.as(
        'bucket_start',
      )
    const rows = await this.db
      .select({
        bucketStart: bucket,
        inputTokens: sql<string>`coalesce(sum(${spendDays.input_tokens}), 0)::bigint`,
        outputTokens: sql<string>`coalesce(sum(${spendDays.output_tokens}), 0)::bigint`,
        calls: sql<string>`coalesce(sum(${spendDays.calls}), 0)::bigint`,
        meteredCost,
        subscriptionCost,
      })
      .from(spendDays)
      .where(this.scopeWhere(scope, range))
      .groupBy(sql`bucket_start`)
      .orderBy(sql`bucket_start`)
    return rows.map((r) => ({
      bucketStart: Number(r.bucketStart),
      meteredCost: r.meteredCost ?? 0,
      subscriptionCost: r.subscriptionCost ?? 0,
      calls: Number(r.calls ?? 0),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
    }))
  }
}

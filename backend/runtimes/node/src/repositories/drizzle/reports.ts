// Cross-cutting usage-analytics rollups over `token_usage` and `agent_runs`, scoped to an
// account by the same `workspaces` sub-select the platform-metrics repo uses (every table
// touched here is a main-store table). Each method is one aggregate query — no row is
// loaded to be reduced in JS. Mirrors `D1ReportsRepository`; the cross-runtime conformance
// suite asserts the two agree.

import type { ReportActivityDimension, ReportSpendDimension } from '@cat-factory/contracts'
import type {
  ReportActivityGroup,
  ReportRange,
  ReportScope,
  ReportSpendGroup,
  ReportSpendTrendBucket,
  ReportsRepository,
} from '@cat-factory/kernel'
import { type SQL, and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { agentRuns, blocks, services, tokenUsage, workspaces } from '../../db/schema.js'

/**
 * The metered/subscription cost split. Anything that is not literally `'subscription'`
 * counts as metered, matching how the row decoders widen the column — so an unexpected
 * value is priced as real spend rather than silently discounted to zero.
 */
const meteredCost = sql<number>`coalesce(sum(case when ${tokenUsage.billing} = 'subscription' then 0 else ${tokenUsage.cost_estimate} end), 0)::float8`
const subscriptionCost = sql<number>`coalesce(sum(case when ${tokenUsage.billing} = 'subscription' then ${tokenUsage.cost_estimate} else 0 end), 0)::float8`

/**
 * The grouped key + resolved label a spend dimension needs. `service` and `taskType` reach
 * the call's run through `execution_id` (a metered call records the run, not the board
 * shape), so a call with no resolvable run falls into the `''` (unattributed) bucket
 * rather than vanishing from the report.
 */
function spendKeyAndLabel(dimension: ReportSpendDimension): {
  key: SQL<string>
  label: SQL<string | null>
} {
  switch (dimension) {
    case 'model':
      return {
        key: sql<string>`(${tokenUsage.provider} || ':' || ${tokenUsage.model})`,
        label: sql<string | null>`null::text`,
      }
    case 'agentKind':
      return { key: sql<string>`${tokenUsage.agent_kind}`, label: sql<string | null>`null::text` }
    case 'workspace':
      return {
        key: sql<string>`${tokenUsage.workspace_id}`,
        label: sql<string | null>`max(${workspaces.name})`,
      }
    case 'service':
      return {
        key: sql<string>`coalesce(${agentRuns.service_id}, '')`,
        label: sql<string | null>`max(${blocks.title})`,
      }
    case 'taskType':
      return {
        key: sql<string>`coalesce(${blocks.task_type}, '')`,
        label: sql<string | null>`null::text`,
      }
  }
}

/** The same, for the run-based activity breakdowns (a run already carries its service/block). */
function activityKeyAndLabel(dimension: ReportActivityDimension): {
  key: SQL<string>
  label: SQL<string | null>
} {
  switch (dimension) {
    case 'workspace':
      return {
        key: sql<string>`${agentRuns.workspace_id}`,
        label: sql<string | null>`max(${workspaces.name})`,
      }
    case 'service':
      return {
        key: sql<string>`coalesce(${agentRuns.service_id}, '')`,
        label: sql<string | null>`max(${blocks.title})`,
      }
    case 'taskType':
      return {
        key: sql<string>`coalesce(${blocks.task_type}, '')`,
        label: sql<string | null>`null::text`,
      }
  }
}

export class DrizzleReportsRepository implements ReportsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** The account's workspace ids, as the sub-select every scope predicate reuses. */
  private accountWorkspaceIds(accountId: string) {
    return this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.account_id, accountId))
  }

  /** Account (+ optional single-workspace) scope and the half-open window, over the ledger. */
  private ledgerWhere(scope: ReportScope, range: ReportRange) {
    return and(
      inArray(tokenUsage.workspace_id, this.accountWorkspaceIds(scope.accountId)),
      scope.workspaceId ? eq(tokenUsage.workspace_id, scope.workspaceId) : undefined,
      gte(tokenUsage.created_at, range.since),
      lt(tokenUsage.created_at, range.until),
    )
  }

  /** The same predicate over the run table. Kept separate so both stay fully column-typed. */
  private runWhere(scope: ReportScope, range: ReportRange) {
    return and(
      inArray(agentRuns.workspace_id, this.accountWorkspaceIds(scope.accountId)),
      scope.workspaceId ? eq(agentRuns.workspace_id, scope.workspaceId) : undefined,
      gte(agentRuns.created_at, range.since),
      lt(agentRuns.created_at, range.until),
    )
  }

  async spendByDimension(
    scope: ReportScope,
    dimension: ReportSpendDimension,
    range: ReportRange,
  ): Promise<ReportSpendGroup[]> {
    const { key, label } = spendKeyAndLabel(dimension)
    // Alias the key expression and GROUP BY / ORDER BY the ALIAS, not the raw fragment:
    // Drizzle re-emits an inline `sql` expression with fresh bind-parameter placeholders in
    // each clause, and Postgres matches GROUP BY columns to the SELECT list by parse-tree
    // identity, so distinct placeholders read as different expressions (error 42803). The
    // platform-metrics trend hit the same trap.
    const groupKey = key.as('k')
    let query = this.db
      .select({
        k: groupKey,
        label,
        inputTokens: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        outputTokens: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        calls: sql<string>`count(*)::bigint`,
        meteredCost,
        subscriptionCost,
      })
      .from(tokenUsage)
      .$dynamic()
    if (dimension === 'workspace') {
      query = query.leftJoin(workspaces, eq(workspaces.id, tokenUsage.workspace_id))
    } else if (dimension === 'service') {
      query = query
        .leftJoin(
          agentRuns,
          and(
            eq(agentRuns.workspace_id, tokenUsage.workspace_id),
            eq(agentRuns.id, tokenUsage.execution_id),
          ),
        )
        .leftJoin(services, eq(services.id, agentRuns.service_id))
        .leftJoin(blocks, eq(blocks.id, services.frame_block_id))
    } else if (dimension === 'taskType') {
      query = query
        .leftJoin(
          agentRuns,
          and(
            eq(agentRuns.workspace_id, tokenUsage.workspace_id),
            eq(agentRuns.id, tokenUsage.execution_id),
          ),
        )
        .leftJoin(
          blocks,
          and(eq(blocks.workspace_id, agentRuns.workspace_id), eq(blocks.id, agentRuns.block_id)),
        )
    }
    const rows = await query
      .where(this.ledgerWhere(scope, range))
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

  async activityByDimension(
    scope: ReportScope,
    dimension: ReportActivityDimension,
    range: ReportRange,
  ): Promise<ReportActivityGroup[]> {
    const { key, label } = activityKeyAndLabel(dimension)
    const groupKey = key.as('k')
    const runs = sql<string>`count(*)::bigint`
    // The status splits AND the terminal-run mean duration are conditional aggregates over
    // the SAME pass — avg() skips the NULLs a non-terminal run contributes, so no second scan.
    let query = this.db
      .select({
        k: groupKey,
        label,
        runs,
        done: sql<string>`sum(case when ${agentRuns.status} = 'done' then 1 else 0 end)::bigint`,
        failed: sql<string>`sum(case when ${agentRuns.status} = 'failed' then 1 else 0 end)::bigint`,
        running: sql<string>`sum(case when ${agentRuns.status} = 'running' then 1 else 0 end)::bigint`,
        other: sql<string>`sum(case when ${agentRuns.status} in ('done', 'failed', 'running') then 0 else 1 end)::bigint`,
        avgDurationMs: sql<
          number | null
        >`avg(case when ${agentRuns.status} in ('done', 'failed') then ${agentRuns.updated_at} - ${agentRuns.created_at} end)::float8`,
      })
      .from(agentRuns)
      .$dynamic()
    if (dimension === 'workspace') {
      query = query.leftJoin(workspaces, eq(workspaces.id, agentRuns.workspace_id))
    } else if (dimension === 'service') {
      query = query
        .leftJoin(services, eq(services.id, agentRuns.service_id))
        .leftJoin(blocks, eq(blocks.id, services.frame_block_id))
    } else if (dimension === 'taskType') {
      query = query.leftJoin(
        blocks,
        and(eq(blocks.workspace_id, agentRuns.workspace_id), eq(blocks.id, agentRuns.block_id)),
      )
    }
    const rows = await query
      .where(this.runWhere(scope, range))
      .groupBy(sql`k`)
      .orderBy(sql`count(*) desc`, sql`k`)
    return rows.map((r) => ({
      key: r.k ?? '',
      label: r.label ?? null,
      runs: Number(r.runs ?? 0),
      done: Number(r.done ?? 0),
      failed: Number(r.failed ?? 0),
      running: Number(r.running ?? 0),
      other: Number(r.other ?? 0),
      avgDurationMs: r.avgDurationMs == null ? null : Math.round(Number(r.avgDurationMs)),
    }))
  }

  async spendTrend(
    scope: ReportScope,
    range: ReportRange,
    bucketMs: number,
  ): Promise<ReportSpendTrendBucket[]> {
    const bucket =
      sql<number>`((${tokenUsage.created_at} / ${bucketMs}::bigint) * ${bucketMs}::bigint)`.as(
        'bucket_start',
      )
    const rows = await this.db
      .select({
        bucketStart: bucket,
        inputTokens: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        outputTokens: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        calls: sql<string>`count(*)::bigint`,
        meteredCost,
        subscriptionCost,
      })
      .from(tokenUsage)
      .where(this.ledgerWhere(scope, range))
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

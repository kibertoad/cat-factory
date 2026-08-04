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
import { type SQL, and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  agentRuns,
  blocks,
  githubRepos,
  services,
  tasks,
  tokenUsage,
  workspaces,
} from '../../db/schema.js'

/**
 * The metered/subscription cost split. Anything that is not literally `'subscription'`
 * counts as metered, matching how the row decoders widen the column — so an unexpected
 * value is priced as real spend rather than silently discounted to zero.
 */
const meteredCost = sql<number>`coalesce(sum(case when ${tokenUsage.billing} = 'subscription' then 0 else ${tokenUsage.cost_estimate} end), 0)::float8`
const subscriptionCost = sql<number>`coalesce(sum(case when ${tokenUsage.billing} = 'subscription' then ${tokenUsage.cost_estimate} else 0 end), 0)::float8`

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
 * `min(title)` still picks arbitrarily among colliding blocks. That ambiguity is confined to
 * the LABEL, which is cosmetic; the aggregates it used to corrupt are not. `services` holds
 * one row per service frame, so materialising this is cheap. Mirrors `SERVICE_LABELS` in the
 * D1 repository.
 */
function serviceLabels(db: DrizzleDb) {
  return (
    db
      // Both fields carry an EXPLICIT alias so the subquery's emitted column names are pinned
      // (and identical to the D1 sub-select's), rather than inherited from the source column.
      .select({
        serviceId: sql<string>`${services.id}`.as('service_id'),
        title: sql<string | null>`min(${blocks.title})`.as('title'),
      })
      .from(services)
      .leftJoin(blocks, eq(blocks.id, services.frame_block_id))
      .groupBy(services.id)
      .as('sl')
  )
}
type ServiceLabels = ReturnType<typeof serviceLabels>

/**
 * The tracker ticket a block is linked to, PRE-AGGREGATED to exactly one row per
 * `(workspace_id, linked_block_id)`.
 *
 * `idx_tasks_block` is a plain index, not a unique one: a block can legitimately be linked from
 * more than one imported issue (two sources, or a re-imported duplicate). Joining `tasks`
 * straight into an aggregate would then FAN OUT, multiplying that block's calls, tokens and cost
 * by the number of tickets pointing at it and leaving the ticket breakdown disagreeing with the
 * window totals. The same trap `serviceLabels` exists for.
 *
 * `min(source || ':' || external_id)` makes the attribution DETERMINISTIC (the lowest ref wins).
 * The ticket TITLE is deliberately not carried out: a second `min` over a different column need
 * not come from the same row, so a multi-linked block could render one ticket's title beside
 * another's ref. The ref is self-describing, so the dimension reports no label at all. Mirrors
 * `TICKET_BY_BLOCK` in the D1 repository.
 */
function ticketByBlock(db: DrizzleDb) {
  return db
    .select({
      workspaceId: sql<string>`${tasks.workspace_id}`.as('ticket_workspace_id'),
      blockId: sql<string>`${tasks.linked_block_id}`.as('ticket_block_id'),
      ticketKey: sql<string>`min(${tasks.source} || ':' || ${tasks.external_id})`.as('ticket_key'),
    })
    .from(tasks)
    .where(and(isNotNull(tasks.linked_block_id), isNull(tasks.deleted_at)))
    .groupBy(tasks.workspace_id, tasks.linked_block_id)
    .as('tk')
}
type TicketByBlock = ReturnType<typeof ticketByBlock>

/**
 * The grouped key + resolved label a spend dimension needs. `service` and `taskType` reach
 * the call's run through `execution_id` (a metered call records the run, not the board
 * shape), so a call with no resolvable run falls into the `''` (unattributed) bucket
 * rather than vanishing from the report.
 */
function spendKeyAndLabel(
  dimension: ReportSpendDimension,
  labels: ServiceLabels,
  tickets: TicketByBlock,
): {
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
        label: sql<string | null>`max(${labels.title})`,
      }
    case 'taskType':
      return {
        key: sql<string>`coalesce(${blocks.task_type}, '')`,
        label: sql<string | null>`null::text`,
      }
    case 'repo':
      return {
        // The KEY comes off the service (which always knows its repo id) and the LABEL off the
        // projection (which the run's workspace may not hold a row in), so an unsynced repo
        // loses its name and keeps its money.
        key: sql<string>`coalesce(${services.repo_github_id}::text, '')`,
        label: sql<string | null>`max(${githubRepos.owner} || '/' || ${githubRepos.name})`,
      }
    case 'ticket':
      return {
        key: sql<string>`coalesce(${tickets.ticketKey}, '')`,
        label: sql<string | null>`null::text`,
      }
  }
}

/** The same, for the run-based activity breakdowns (a run already carries its service/block). */
function activityKeyAndLabel(
  dimension: ReportActivityDimension,
  labels: ServiceLabels,
): {
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
        label: sql<string | null>`max(${labels.title})`,
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
    const labels = serviceLabels(this.db)
    const tickets = ticketByBlock(this.db)
    const { key, label } = spendKeyAndLabel(dimension, labels, tickets)
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
        .leftJoin(labels, eq(labels.serviceId, agentRuns.service_id))
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
    } else if (dimension === 'repo') {
      // `services.id` is a primary key and `(workspace_id, github_id)` is `github_repos`'
      // primary key, so both joins are provably 1:1 and cannot fan the aggregate out.
      query = query
        .leftJoin(
          agentRuns,
          and(
            eq(agentRuns.workspace_id, tokenUsage.workspace_id),
            eq(agentRuns.id, tokenUsage.execution_id),
          ),
        )
        .leftJoin(services, eq(services.id, agentRuns.service_id))
        .leftJoin(
          githubRepos,
          and(
            eq(githubRepos.workspace_id, tokenUsage.workspace_id),
            eq(githubRepos.github_id, services.repo_github_id),
          ),
        )
    } else if (dimension === 'ticket') {
      query = query
        .leftJoin(
          agentRuns,
          and(
            eq(agentRuns.workspace_id, tokenUsage.workspace_id),
            eq(agentRuns.id, tokenUsage.execution_id),
          ),
        )
        .leftJoin(
          tickets,
          and(
            eq(tickets.workspaceId, agentRuns.workspace_id),
            eq(tickets.blockId, agentRuns.block_id),
          ),
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
    const labels = serviceLabels(this.db)
    const { key, label } = activityKeyAndLabel(dimension, labels)
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
      query = query.leftJoin(labels, eq(labels.serviceId, agentRuns.service_id))
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

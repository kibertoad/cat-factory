// The Drizzle/Postgres spend LEDGER. Split out of `telemetry.ts` along the boundary the
// architecture already draws: `token_usage` is the one store in that file that only LOOKS like
// telemetry. It is the org's BUDGET SAFEGUARD, durable rather than 3-day, read by the spend gate
// before every agent step and by the forecast sweep behind the proactive budget alerts, and it is
// the one repository in the group that is remotely callable in mothership mode. Keeping it in a
// sibling module (re-exported from the barrel, so every importer sees the same surface) makes
// that grouping visible in the file layout and keeps the telemetry module under its size budget.
// Same pattern as `db/schema/tracker.ts`.

import type {
  ScopedSpendWindow,
  TokenUsageRecord,
  TokenUsageRepository,
  TokenUsageTotals,
  UsageBilling,
  UsageBreakdownRow,
} from '@cat-factory/kernel'
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { tokenUsage } from '../../db/schema.js'

export class DrizzleTokenUsageRepository implements TokenUsageRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(usage: TokenUsageRecord): Promise<void> {
    await this.db.insert(tokenUsage).values({
      id: usage.id,
      workspace_id: usage.workspaceId,
      account_id: usage.accountId,
      user_id: usage.userId,
      execution_id: usage.executionId,
      agent_kind: usage.agentKind,
      provider: usage.provider,
      model: usage.model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_estimate: usage.costEstimate,
      billing: usage.billing,
      vendor: usage.vendor,
      created_at: usage.createdAt,
    })
  }

  async usageBreakdownForWorkspace(
    workspaceId: string,
    epochMs: number,
  ): Promise<UsageBreakdownRow[]> {
    // One GROUP BY over the workspace's current period — both billing kinds (the report
    // shows total usage). Never a per-model loop. sum() of int columns is bigint; cast +
    // coerce like the totals rollups. Ordered heaviest-first in SQL, mirroring the D1 repo.
    const rows = await this.db
      .select({
        billing: tokenUsage.billing,
        vendor: tokenUsage.vendor,
        provider: tokenUsage.provider,
        model: tokenUsage.model,
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
        calls: sql<string>`count(*)::bigint`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.workspace_id, workspaceId), gte(tokenUsage.created_at, epochMs)))
      .groupBy(tokenUsage.billing, tokenUsage.vendor, tokenUsage.provider, tokenUsage.model)
      .orderBy(
        sql`(coalesce(sum(${tokenUsage.input_tokens}), 0) + coalesce(sum(${tokenUsage.output_tokens}), 0)) desc`,
      )
    return rows.map((r) => ({
      billing: (r.billing === 'subscription' ? 'subscription' : 'metered') as UsageBilling,
      vendor: r.vendor,
      provider: r.provider,
      model: r.model,
      inputTokens: Number(r.input ?? 0),
      outputTokens: Number(r.output ?? 0),
      costEstimate: r.cost ?? 0,
      calls: Number(r.calls ?? 0),
    }))
  }

  async totalsSince(epochMs: number): Promise<TokenUsageTotals> {
    // sum() of int columns is bigint in Postgres — cast to bigint (NOT int4, which
    // overflows past ~2.1B tokens) and coerce: node-postgres returns bigint as a
    // string to avoid precision loss, and token totals stay well within Number's
    // safe-integer range. Matches the 64-bit sum the D1/SQLite store returns.
    const [row] = await this.db
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
      })
      .from(tokenUsage)
      .where(and(gte(tokenUsage.created_at, epochMs), eq(tokenUsage.billing, 'metered')))
    return {
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      costEstimate: row?.cost ?? 0,
    }
  }

  async totalsSinceForWorkspace(workspaceId: string, epochMs: number): Promise<TokenUsageTotals> {
    const [row] = await this.db
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
      })
      .from(tokenUsage)
      .where(
        and(
          eq(tokenUsage.workspace_id, workspaceId),
          gte(tokenUsage.created_at, epochMs),
          eq(tokenUsage.billing, 'metered'),
        ),
      )
    return {
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      costEstimate: row?.cost ?? 0,
    }
  }

  async totalsSinceForAccount(accountId: string, epochMs: number): Promise<TokenUsageTotals> {
    const [row] = await this.db
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
      })
      .from(tokenUsage)
      .where(
        and(
          eq(tokenUsage.account_id, accountId),
          gte(tokenUsage.created_at, epochMs),
          eq(tokenUsage.billing, 'metered'),
        ),
      )
    return {
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      costEstimate: row?.cost ?? 0,
    }
  }

  async totalsSinceForUser(userId: string, epochMs: number): Promise<TokenUsageTotals> {
    const [row] = await this.db
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
      })
      .from(tokenUsage)
      .where(
        and(
          eq(tokenUsage.user_id, userId),
          gte(tokenUsage.created_at, epochMs),
          eq(tokenUsage.billing, 'metered'),
        ),
      )
    return {
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      costEstimate: row?.cost ?? 0,
    }
  }

  async meteredSpendByWorkspaceSince(
    workspaceIds: string[],
    epochMs: number,
  ): Promise<Map<string, ScopedSpendWindow>> {
    return this.meteredSpendByScope(tokenUsage.workspace_id, workspaceIds, epochMs)
  }

  async meteredSpendByAccountSince(
    accountIds: string[],
    epochMs: number,
  ): Promise<Map<string, ScopedSpendWindow>> {
    return this.meteredSpendByScope(tokenUsage.account_id, accountIds, epochMs)
  }

  /**
   * One `GROUP BY` over the scope column for the whole id set, with the window's oldest row
   * carried out beside the sum in the SAME pass (a second `MIN(created_at)` scan would double
   * the sweep's cost for a column already in the aggregate).
   */
  private async meteredSpendByScope(
    column: typeof tokenUsage.workspace_id | typeof tokenUsage.account_id,
    ids: string[],
    epochMs: number,
  ): Promise<Map<string, ScopedSpendWindow>> {
    const out = new Map<string, ScopedSpendWindow>()
    if (ids.length === 0) return out
    // ONE grouped read per chunk (never a per-scope point-read loop), matching the
    // chunked-IN convention the board repository sets.
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.db
        .select({
          key: column,
          cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
          firstSeenAt: sql<string>`min(${tokenUsage.created_at})::bigint`,
        })
        .from(tokenUsage)
        .where(
          and(
            inArray(column, ids.slice(i, i + 500)),
            gte(tokenUsage.created_at, epochMs),
            eq(tokenUsage.billing, 'metered'),
          ),
        )
        .groupBy(column)
      for (const row of rows) {
        // A grouped row always has both a key and a `min()`; the guard is for the nullable
        // account column, whose NULL group is a real row here and belongs to no account.
        if (row.key == null || row.firstSeenAt == null) continue
        out.set(row.key, { costEstimate: row.cost ?? 0, firstSeenAt: Number(row.firstSeenAt) })
      }
    }
    return out
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(tokenUsage)
      .where(lt(tokenUsage.created_at, epochMs))
      .returning({ id: tokenUsage.id })
    return deleted.length
  }
}

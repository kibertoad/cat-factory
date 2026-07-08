import type {
  TokenUsageRecord,
  TokenUsageRepository,
  TokenUsageTotals,
  UsageBilling,
  UsageBreakdownRow,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

/** D1-backed ledger for the spend safeguard + usage report (see migration 0044). */
export class D1TokenUsageRepository implements TokenUsageRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async record(usage: TokenUsageRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO token_usage
           (id, workspace_id, account_id, user_id, execution_id, agent_kind, provider, model,
            input_tokens, output_tokens, cost_estimate, billing, vendor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        usage.id,
        usage.workspaceId,
        usage.accountId,
        usage.userId,
        usage.executionId,
        usage.agentKind,
        usage.provider,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.costEstimate,
        usage.billing,
        usage.vendor,
        usage.createdAt,
      )
      .run()
  }

  async usageBreakdownForWorkspace(
    workspaceId: string,
    epochMs: number,
  ): Promise<UsageBreakdownRow[]> {
    // One GROUP BY over the workspace's current period (idx_token_usage_workspace bounds
    // the scan) — both billing kinds, so the report shows total usage. Never a per-model loop.
    const { results } = await this.db
      .prepare(
        `SELECT billing, vendor, provider, model,
                COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_estimate), 0) AS cost_estimate,
                COUNT(*)                        AS calls
         FROM token_usage
         WHERE workspace_id = ? AND created_at >= ?
         GROUP BY billing, vendor, provider, model
         ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC`,
      )
      .bind(workspaceId, epochMs)
      .all<{
        billing: string
        vendor: string | null
        provider: string
        model: string
        input_tokens: number
        output_tokens: number
        cost_estimate: number
        calls: number
      }>()
    return (results ?? []).map((r) => ({
      billing: (r.billing === 'subscription' ? 'subscription' : 'metered') as UsageBilling,
      vendor: r.vendor,
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costEstimate: r.cost_estimate,
      calls: r.calls,
    }))
  }

  async totalsSince(epochMs: number): Promise<TokenUsageTotals> {
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)  AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_estimate), 0) AS cost_estimate
         FROM token_usage
         WHERE created_at >= ? AND billing = 'metered'`,
      )
      .bind(epochMs)
      .first<{ input_tokens: number; output_tokens: number; cost_estimate: number }>()
    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      costEstimate: row?.cost_estimate ?? 0,
    }
  }

  async totalsSinceForWorkspace(workspaceId: string, epochMs: number): Promise<TokenUsageTotals> {
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)  AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_estimate), 0) AS cost_estimate
         FROM token_usage
         WHERE workspace_id = ? AND created_at >= ? AND billing = 'metered'`,
      )
      .bind(workspaceId, epochMs)
      .first<{ input_tokens: number; output_tokens: number; cost_estimate: number }>()
    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      costEstimate: row?.cost_estimate ?? 0,
    }
  }

  async totalsSinceForAccount(accountId: string, epochMs: number): Promise<TokenUsageTotals> {
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)  AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_estimate), 0) AS cost_estimate
         FROM token_usage
         WHERE account_id = ? AND created_at >= ? AND billing = 'metered'`,
      )
      .bind(accountId, epochMs)
      .first<{ input_tokens: number; output_tokens: number; cost_estimate: number }>()
    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      costEstimate: row?.cost_estimate ?? 0,
    }
  }

  async totalsSinceForUser(userId: string, epochMs: number): Promise<TokenUsageTotals> {
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)  AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_estimate), 0) AS cost_estimate
         FROM token_usage
         WHERE user_id = ? AND created_at >= ? AND billing = 'metered'`,
      )
      .bind(userId, epochMs)
      .first<{ input_tokens: number; output_tokens: number; cost_estimate: number }>()
    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      costEstimate: row?.cost_estimate ?? 0,
    }
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_token_usage_created; bounded by the rows being pruned.
    const { meta } = await this.db
      .prepare('DELETE FROM token_usage WHERE created_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}

import type { TokenUsageRecord, TokenUsageRepository, TokenUsageTotals } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

/** D1-backed ledger for the spend safeguard (see migration 0003). */
export class D1TokenUsageRepository implements TokenUsageRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async record(usage: TokenUsageRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO token_usage
           (id, workspace_id, execution_id, agent_kind, provider, model,
            input_tokens, output_tokens, cost_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        usage.id,
        usage.workspaceId,
        usage.executionId,
        usage.agentKind,
        usage.provider,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.costEstimate,
        usage.createdAt,
      )
      .run()
  }

  async totalsSince(epochMs: number): Promise<TokenUsageTotals> {
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)  AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_estimate), 0) AS cost_estimate
         FROM token_usage
         WHERE created_at >= ?`,
      )
      .bind(epochMs)
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

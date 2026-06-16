import type { AgentRunKind } from '@cat-factory/contracts'
import type { AgentRunRef, AgentRunRepository } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * Kind-spanning reads over the unified `agent_runs` table (migration 0019). Writes
 * stay with the per-flow repositories (D1ExecutionRepository / D1BootstrapJobRepository),
 * each scoped to its own `kind`; this one answers the questions that cross both:
 * what kind is a given run (for retry dispatch), and which runs are stale (for the
 * unified sweeper).
 */
export class D1AgentRunRepository implements AgentRunRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getRef(workspaceId: string, id: string): Promise<AgentRunRef | null> {
    const row = await this.db
      .prepare('SELECT kind FROM agent_runs WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<{ kind: string }>()
    return row ? { workspaceId, id, kind: row.kind as AgentRunKind } : null
  }

  async listStale(olderThanEpochMs: number): Promise<AgentRunRef[]> {
    const { results } = await this.db
      .prepare(
        `SELECT workspace_id, id, kind FROM agent_runs
         WHERE status = 'running' AND updated_at < ?
         ORDER BY updated_at`,
      )
      .bind(olderThanEpochMs)
      .all<{ workspace_id: string; id: string; kind: string }>()
    return (results ?? []).map((r) => ({
      workspaceId: r.workspace_id,
      id: r.id,
      kind: r.kind as AgentRunKind,
    }))
  }
}

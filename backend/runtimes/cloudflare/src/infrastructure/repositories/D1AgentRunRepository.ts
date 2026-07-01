import { agentRunKindSchema } from '@cat-factory/contracts'
import type { AgentRunRef, AgentRunRepository, StaleAgentRun } from '@cat-factory/kernel'
import { decodeEnum } from '@cat-factory/server'
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
    return row
      ? {
          workspaceId,
          id,
          kind: decodeEnum(agentRunKindSchema, row.kind, {
            table: 'agent_runs',
            column: 'kind',
            id,
          }),
        }
      : null
  }

  async listStale(olderThanEpochMs: number): Promise<StaleAgentRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT workspace_id, id, kind, updated_at FROM agent_runs
         WHERE status = 'running' AND updated_at < ?
         ORDER BY updated_at`,
      )
      .bind(olderThanEpochMs)
      .all<{ workspace_id: string; id: string; kind: string; updated_at: number }>()
    return (results ?? []).map((r) => ({
      workspaceId: r.workspace_id,
      id: r.id,
      updatedAt: r.updated_at,
      kind: decodeEnum(agentRunKindSchema, r.kind, {
        table: 'agent_runs',
        column: 'kind',
        id: r.id,
      }),
    }))
  }

  async liveRunIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return []
    const live: string[] = []
    // Chunk the IN list so a large set never blows the SQL variable limit (batch, not N+1).
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT id FROM agent_runs
           WHERE status IN ('running', 'blocked', 'paused', 'pending') AND id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{ id: string }>()
      for (const r of results ?? []) live.push(r.id)
    }
    return live
  }
}

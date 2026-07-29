import type {
  AgentSearchQuery,
  AgentSearchQueryPageQuery,
  AgentSearchQueryRepository,
} from '@cat-factory/kernel'
import { isWebSearchProvider } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface SearchQueryRow {
  id: string
  workspace_id: string
  execution_id: string
  agent_kind: string
  provider: string | null
  query: string
  result_count: number
  created_at: number
}

function rowToQuery(row: SearchQueryRow): AgentSearchQuery {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    // The stored provider column is free-text TEXT; narrow it back to the wire union.
    provider: isWebSearchProvider(row.provider) ? row.provider : null,
    query: row.query,
    resultCount: row.result_count,
    createdAt: row.created_at,
  }
}

/**
 * D1-backed sink for agent-search-query observability. Lives in the dedicated
 * TELEMETRY_DB database (see `telemetry-migrations/`), alongside `llm_call_metrics`
 * and `agent_context_snapshots`.
 */
export class D1AgentSearchQueryRepository implements AgentSearchQueryRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async record(query: AgentSearchQuery): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_search_queries
           (id, workspace_id, execution_id, agent_kind, provider, query, result_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        query.id,
        query.workspaceId,
        query.executionId,
        query.agentKind,
        query.provider,
        query.query,
        query.resultCount,
        query.createdAt,
      )
      .run()
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<AgentSearchQuery[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_search_queries
         WHERE workspace_id = ? AND execution_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(workspaceId, executionId)
      .all<SearchQueryRow>()
    return (results ?? []).map(rowToQuery)
  }

  async listPage(
    workspaceId: string,
    query: AgentSearchQueryPageQuery,
  ): Promise<AgentSearchQuery[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: unknown[] = [workspaceId, query.executionId]
    if (query.cursor) {
      // Composite keyset matching the ORDER BY, so rows sharing a `created_at` millisecond
      // are not skipped between pages. Mirrors the Drizzle repo.
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_search_queries
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...binds)
      .all<SearchQueryRow>()
    return (results ?? []).map(rowToQuery)
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM agent_search_queries WHERE workspace_id = ? AND execution_id = ?',
      )
      .bind(workspaceId, executionId)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_agent_search_queries_created; bounded by the rows pruned.
    const { meta } = await this.db
      .prepare('DELETE FROM agent_search_queries WHERE created_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}

import type {
  AgentToolCall,
  AgentToolCallPageQuery,
  AgentToolCallRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ToolCallRow {
  id: string
  workspace_id: string
  execution_id: string
  agent_kind: string
  job_id: string
  seq: number
  tool: string
  started_at: number
  ended_at: number
  ok: number
  bodies: string
  args: string
  result: string
  args_dropped: number
  result_dropped: number
  created_at: number
}

function rowToCall(row: ToolCallRow): AgentToolCall {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    jobId: row.job_id,
    seq: row.seq,
    tool: row.tool,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ok: row.ok === 1,
    // The stored column is free-text TEXT; narrow it back to the wire union. Anything else is
    // read as `withheld`, the answer that claims nothing about a body we cannot account for.
    bodies: row.bodies === 'stored' ? 'stored' : 'withheld',
    args: row.args,
    result: row.result,
    argsDropped: row.args_dropped,
    resultDropped: row.result_dropped,
    createdAt: row.created_at,
  }
}

/**
 * Statements per `db.batch` in the batch append. D1 executes a batch in one round trip as an
 * implicit transaction; chunking keeps a tool-heavy poll window off any single-request ceiling.
 */
const INSERT_CHUNK_SIZE = 50

/**
 * D1-backed sink for the tool-call trajectory. Lives in the dedicated TELEMETRY_DB database
 * (see `telemetry-migrations/`), alongside `llm_call_metrics`, `agent_context_snapshots` and
 * `agent_search_queries`.
 */
export class D1AgentToolCallRepository implements AgentToolCallRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async recordMany(calls: AgentToolCall[]): Promise<void> {
    // One `batch` per chunk — a single round trip and one implicit transaction each — never a
    // per-row loop (the banned N+1 write). `ON CONFLICT(id) DO NOTHING` and not an upsert: a
    // re-offered call is byte-identical to the stored one (its id derives from `(jobId, seq)`),
    // so first write wins and a durable replay costs nothing.
    const statements = calls.map((call) => this.insertStatement(call))
    for (let i = 0; i < statements.length; i += INSERT_CHUNK_SIZE) {
      await this.db.batch(statements.slice(i, i + INSERT_CHUNK_SIZE))
    }
  }

  private insertStatement(call: AgentToolCall) {
    return this.db
      .prepare(
        `INSERT INTO agent_tool_calls
           (id, workspace_id, execution_id, agent_kind, job_id, seq, tool, started_at, ended_at,
            ok, bodies, args, result, args_dropped, result_dropped, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        call.id,
        call.workspaceId,
        call.executionId,
        call.agentKind,
        call.jobId,
        call.seq,
        call.tool,
        call.startedAt,
        call.endedAt,
        call.ok ? 1 : 0,
        call.bodies,
        call.args,
        call.result,
        call.argsDropped,
        call.resultDropped,
        call.createdAt,
      )
  }

  async listByExecution(
    workspaceId: string,
    executionId: string,
    limit: number,
  ): Promise<AgentToolCall[]> {
    // Trajectory order: oldest first, by dispatch then ordinal. The `limit` takes the OLDEST
    // end, so a truncated read is a prefix of the run rather than a middle slice.
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_tool_calls
         WHERE workspace_id = ? AND execution_id = ?
         ORDER BY job_id ASC, seq ASC
         LIMIT ?`,
      )
      .bind(workspaceId, executionId, limit)
      .all<ToolCallRow>()
    return (results ?? []).map(rowToCall)
  }

  async listPage(workspaceId: string, query: AgentToolCallPageQuery): Promise<AgentToolCall[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: unknown[] = [workspaceId, query.executionId]
    if (query.jobId) {
      clauses.push('job_id = ?')
      binds.push(query.jobId)
    }
    if (query.cursor) {
      // Composite keyset matching the ORDER BY, so rows sharing a `created_at` millisecond are
      // not skipped between pages — which on this sink is the COMMON case, not the corner one:
      // a whole poll window's calls are stamped at one instant. Mirrors the Drizzle repo.
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_tool_calls
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...binds)
      .all<ToolCallRow>()
    return (results ?? []).map(rowToCall)
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM agent_tool_calls WHERE workspace_id = ? AND execution_id = ?',
      )
      .bind(workspaceId, executionId)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_agent_tool_calls_created; bounded by the rows pruned.
    const { meta } = await this.db
      .prepare('DELETE FROM agent_tool_calls WHERE created_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}

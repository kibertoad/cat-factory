import type {
  AgentToolCall,
  AgentToolCallCounts,
  AgentToolCallPageQuery,
  AgentToolCallRepository,
  AgentToolCallTrajectoryQuery,
  ToolCallOutcome,
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
 * The stored `ok` value an outcome filter selects. The column is an INTEGER flag (SQLite has no
 * boolean), so the mapping is stated once here rather than spelled `ok = 0` at each call site,
 * where inverting it is a one-character bug that returns a plausible-looking page.
 */
function okFlagFor(outcome: ToolCallOutcome): number {
  return outcome === 'ok' ? 1 : 0
}

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
    query: AgentToolCallTrajectoryQuery,
  ): Promise<AgentToolCall[]> {
    // Trajectory order: oldest first by the call's own start, `seq` separating the calls that
    // share a millisecond and `id` making the order total. NOT by `job_id`, which is a string
    // that sorts a run's dispatches alphabetically. The `limit` takes the OLDEST end, so a
    // truncated read is a prefix of the run rather than a middle slice.
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: unknown[] = [workspaceId, query.executionId]
    if (query.jobId) {
      clauses.push('job_id = ?')
      binds.push(query.jobId)
    }
    if (query.outcome) {
      // Narrowed IN SQL, before the `limit` takes the oldest end: filtering afterwards would
      // spend the prefix on rows it discards, so a run whose failures sit past call 200 would
      // report none at all.
      clauses.push('ok = ?')
      binds.push(okFlagFor(query.outcome))
    }
    binds.push(query.limit)
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_tool_calls
         WHERE ${clauses.join(' AND ')}
         ORDER BY started_at ASC, seq ASC, id ASC
         LIMIT ?`,
      )
      .bind(...binds)
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
    if (query.outcome) {
      clauses.push('ok = ?')
      binds.push(okFlagFor(query.outcome))
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

  async countByExecution(workspaceId: string, executionId: string): Promise<AgentToolCallCounts> {
    // Total and failures in ONE pass over the same index range: two queries could be read at
    // different instants mid-run and report more failures than calls.
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
           FROM agent_tool_calls WHERE workspace_id = ? AND execution_id = ?`,
      )
      .bind(workspaceId, executionId)
      .first<{ n: number; failed: number | null }>()
    // `SUM` over no rows is NULL, not 0, and that NULL means "this run recorded nothing",
    // the same fact the 0 total states, so it is read as 0 rather than left to surface as a
    // `null` the wire schema does not allow.
    return { total: row?.n ?? 0, failed: row?.failed ?? 0 }
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

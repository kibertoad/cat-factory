import type {
  AgentContextFile,
  AgentContextFragment,
  AgentContextIndexQuery,
  AgentContextRunPageQuery,
  AgentContextSnapshot,
  AgentContextSnapshotIndex,
  AgentContextSnapshotRepository,
} from '@cat-factory/kernel'
import type { DispatchedToolServer } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface SnapshotRow {
  id: string
  workspace_id: string
  execution_id: string
  agent_kind: string
  step_index: number
  created_at: number
  model: string | null
  harness: string | null
  system_prompt: string
  user_prompt: string
  fragments: string
  context_files: string
  extras: string
  tool_servers: string
}

function parseArray<T>(text: string): T[] {
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

interface IndexRow {
  id: string
  agent_kind: string
  step_index: number
  created_at: number
  model: string | null
  harness: string | null
  system_prompt_chars: number
  user_prompt_chars: number
  fragments_chars: number
  context_files_chars: number
}

function rowToIndex(row: IndexRow): AgentContextSnapshotIndex {
  return {
    id: row.id,
    agentKind: row.agent_kind,
    stepIndex: row.step_index,
    createdAt: row.created_at,
    model: row.model,
    harness: row.harness,
    systemPromptChars: row.system_prompt_chars ?? 0,
    userPromptChars: row.user_prompt_chars ?? 0,
    fragmentsChars: row.fragments_chars ?? 0,
    contextFilesChars: row.context_files_chars ?? 0,
  }
}

function rowToSnapshot(row: SnapshotRow): AgentContextSnapshot {
  const toolServers = parseArray<DispatchedToolServer>(row.tool_servers)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    stepIndex: row.step_index,
    createdAt: row.created_at,
    model: row.model,
    harness: row.harness,
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    fragments: parseArray<AgentContextFragment>(row.fragments),
    contextFiles: parseArray<AgentContextFile>(row.context_files),
    extras: parseObject(row.extras),
    // Absent rather than empty when the dispatch resolved no declarations, so a stock run's
    // snapshot does not render an empty "MCP tool servers" section on every step. A row written
    // before the column existed reads as '[]' (the column's default), which is that same fact.
    ...(toolServers.length ? { toolServers } : {}),
  }
}

/**
 * Statements per `db.batch` in the batch append — small, because one snapshot row is routinely
 * megabytes (the composed prompt plus every injected `.cat-context/*` file's body).
 */
const SNAPSHOT_CHUNK_SIZE = 10

/**
 * D1-backed sink for agent-context observability. Lives in the dedicated TELEMETRY_DB
 * database (see `telemetry-migrations/`), alongside `llm_call_metrics`.
 */
export class D1AgentContextSnapshotRepository implements AgentContextSnapshotRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async record(snapshot: AgentContextSnapshot): Promise<void> {
    await this.insertStatement(snapshot, false).run()
  }

  async recordMany(snapshots: AgentContextSnapshot[]): Promise<void> {
    // One `batch` per chunk (a single round trip each) — never a `record` loop. Chunked SMALL:
    // one snapshot row carries the whole composed prompt plus every injected context file's body.
    // Idempotent by id (see the port) because the ingest retries a chunk whose ack was lost.
    const statements = snapshots.map((snapshot) => this.insertStatement(snapshot, true))
    for (let i = 0; i < statements.length; i += SNAPSHOT_CHUNK_SIZE) {
      await this.db.batch(statements.slice(i, i + SNAPSHOT_CHUNK_SIZE))
    }
  }

  private insertStatement(snapshot: AgentContextSnapshot, ignoreDuplicateId: boolean) {
    return this.db
      .prepare(
        `INSERT INTO agent_context_snapshots
           (id, workspace_id, execution_id, agent_kind, step_index, created_at,
            model, harness, system_prompt, user_prompt, fragments, context_files, extras,
            tool_servers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${
           ignoreDuplicateId ? ' ON CONFLICT(id) DO NOTHING' : ''
         }`,
      )
      .bind(
        snapshot.id,
        snapshot.workspaceId,
        snapshot.executionId,
        snapshot.agentKind,
        snapshot.stepIndex,
        snapshot.createdAt,
        snapshot.model,
        snapshot.harness,
        snapshot.systemPrompt,
        snapshot.userPrompt,
        JSON.stringify(snapshot.fragments),
        JSON.stringify(snapshot.contextFiles),
        JSON.stringify(snapshot.extras),
        JSON.stringify(snapshot.toolServers ?? []),
      )
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<AgentContextSnapshot[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_context_snapshots
         WHERE workspace_id = ? AND execution_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(workspaceId, executionId)
      .all<SnapshotRow>()
    return (results ?? []).map(rowToSnapshot)
  }

  async listIndex(
    workspaceId: string,
    query: AgentContextIndexQuery,
  ): Promise<AgentContextSnapshotIndex[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: unknown[] = [workspaceId, query.executionId]
    if (query.stepIndex != null) {
      clauses.push('step_index = ?')
      binds.push(query.stepIndex)
    }
    if (query.cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    // Sizes only — the four body-bearing columns are MEASURED, never selected, so listing a
    // run's dispatches costs no body bytes even though a single snapshot can be megabytes.
    const { results } = await this.db
      .prepare(
        `SELECT id, agent_kind, step_index, created_at, model, harness,
                length(system_prompt) AS system_prompt_chars,
                length(user_prompt)   AS user_prompt_chars,
                length(fragments)     AS fragments_chars,
                length(context_files) AS context_files_chars
         FROM agent_context_snapshots
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...binds)
      .all<IndexRow>()
    return (results ?? []).map(rowToIndex)
  }

  async listRunPage(
    workspaceId: string,
    query: AgentContextRunPageQuery,
  ): Promise<AgentContextSnapshot[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: unknown[] = [workspaceId, query.executionId]
    if (query.stepIndex != null) {
      clauses.push('step_index = ?')
      binds.push(query.stepIndex)
    }
    if (query.cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    // Same predicate, ordering and keyset as `listIndex` — bodies included. Keeping the two in
    // step is what lets a caller page the index and then page the rows and see the same run.
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_context_snapshots
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...binds)
      .all<SnapshotRow>()
    return (results ?? []).map(rowToSnapshot)
  }

  async get(workspaceId: string, id: string): Promise<AgentContextSnapshot | null> {
    const row = await this.db
      .prepare('SELECT * FROM agent_context_snapshots WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<SnapshotRow>()
    return row ? rowToSnapshot(row) : null
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM agent_context_snapshots WHERE workspace_id = ? AND execution_id = ?',
      )
      .bind(workspaceId, executionId)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_agent_context_snapshots_created; bounded by the rows pruned.
    const { meta } = await this.db
      .prepare('DELETE FROM agent_context_snapshots WHERE created_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}

import type {
  AgentContextFile,
  AgentContextFragment,
  AgentContextSnapshot,
  AgentContextSnapshotRepository,
} from '@cat-factory/kernel'
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

function rowToSnapshot(row: SnapshotRow): AgentContextSnapshot {
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
  }
}

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
    await this.db
      .prepare(
        `INSERT INTO agent_context_snapshots
           (id, workspace_id, execution_id, agent_kind, step_index, created_at,
            model, harness, system_prompt, user_prompt, fragments, context_files, extras)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run()
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

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_agent_context_snapshots_created; bounded by the rows pruned.
    const { meta } = await this.db
      .prepare('DELETE FROM agent_context_snapshots WHERE created_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}

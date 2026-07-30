import type { WorkspaceAgentSettingsRepository } from '@cat-factory/kernel'
import type { WorkspaceAgentSettings } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface WorkspaceAgentSettingsRow {
  agent_kind: string
  max_output_tokens: number | null
  updated_at: number
}

function rowToSettings(row: WorkspaceAgentSettingsRow): WorkspaceAgentSettings {
  return {
    agentKind: row.agent_kind,
    maxOutputTokens: row.max_output_tokens,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-workspace, per-agent-kind generation settings in `workspace_agent_settings`
 * (migration 0071). One row per kind; no row (or a NULL `max_output_tokens`) means the kind
 * inherits the deployment routing default.
 *
 * `upsert` is conflict-targeted on the full primary key, so re-saving a kind replaces its value
 * rather than accumulating rows — the deliberate opposite of `D1AgentPromptRepository.append`,
 * whose collision is the concurrency control. See the port for why the two differ.
 */
export class D1WorkspaceAgentSettingsRepository implements WorkspaceAgentSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, agentKind: string): Promise<WorkspaceAgentSettings | null> {
    const row = await this.db
      .prepare(
        `SELECT agent_kind, max_output_tokens, updated_at
           FROM workspace_agent_settings
           WHERE workspace_id = ? AND agent_kind = ?`,
      )
      .bind(workspaceId, agentKind)
      .first<WorkspaceAgentSettingsRow>()
    return row ? rowToSettings(row) : null
  }

  async list(workspaceId: string): Promise<WorkspaceAgentSettings[]> {
    const { results } = await this.db
      .prepare(
        `SELECT agent_kind, max_output_tokens, updated_at
           FROM workspace_agent_settings
           WHERE workspace_id = ?
           ORDER BY agent_kind ASC`,
      )
      .bind(workspaceId)
      .all<WorkspaceAgentSettingsRow>()
    return results.map(rowToSettings)
  }

  async upsert(workspaceId: string, settings: WorkspaceAgentSettings): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workspace_agent_settings
           (workspace_id, agent_kind, max_output_tokens, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, agent_kind) DO UPDATE SET
           max_output_tokens = excluded.max_output_tokens,
           updated_at = excluded.updated_at`,
      )
      .bind(workspaceId, settings.agentKind, settings.maxOutputTokens, settings.updatedAt)
      .run()
  }

  async remove(workspaceId: string, agentKind: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM workspace_agent_settings WHERE workspace_id = ? AND agent_kind = ?`)
      .bind(workspaceId, agentKind)
      .run()
  }
}

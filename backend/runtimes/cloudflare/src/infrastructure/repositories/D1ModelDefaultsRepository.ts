import type { ModelDefaultsRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ModelDefaultRow {
  agent_kind: string
  model_id: string
}

/**
 * A workspace's per-agent-kind default models, one row per (workspace, agent kind)
 * in `workspace_model_defaults` (migration 0028). `replace` rewrites the whole map
 * for a workspace atomically (delete-all then insert-each in one `db.batch`), so a
 * kind omitted from the new map is cleared.
 */
export class D1ModelDefaultsRepository implements ModelDefaultsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<Record<string, string>> {
    const { results } = await this.db
      .prepare(`SELECT agent_kind, model_id FROM workspace_model_defaults WHERE workspace_id = ?`)
      .bind(workspaceId)
      .all<ModelDefaultRow>()
    const map: Record<string, string> = {}
    for (const row of results) map[row.agent_kind] = row.model_id
    return map
  }

  async getForKind(workspaceId: string, agentKind: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT model_id FROM workspace_model_defaults WHERE workspace_id = ? AND agent_kind = ?`,
      )
      .bind(workspaceId, agentKind)
      .first<{ model_id: string }>()
    return row ? row.model_id : null
  }

  async replace(workspaceId: string, defaults: Record<string, string>): Promise<void> {
    // Rewrite the whole per-kind map atomically: clear the workspace's rows, then
    // insert one per entry. Batched so the snapshot a reader sees is consistent.
    const statements = [
      this.db
        .prepare(`DELETE FROM workspace_model_defaults WHERE workspace_id = ?`)
        .bind(workspaceId),
    ]
    const updatedAt = Date.now()
    for (const [agentKind, modelId] of Object.entries(defaults)) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO workspace_model_defaults (workspace_id, agent_kind, model_id, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(workspaceId, agentKind, modelId, updatedAt),
      )
    }
    await this.db.batch(statements)
  }
}

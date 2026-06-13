import type { WorkspaceRepository } from '@cat-factory/core'
import type { Workspace } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type WorkspaceRow, rowToWorkspace } from './mappers'

export class D1WorkspaceRepository implements WorkspaceRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async list(): Promise<Workspace[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM workspaces ORDER BY created_at DESC')
      .all<WorkspaceRow>()
    return results.map(rowToWorkspace)
  }

  async get(id: string): Promise<Workspace | null> {
    const row = await this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .bind(id)
      .first<WorkspaceRow>()
    return row ? rowToWorkspace(row) : null
  }

  async create(workspace: Workspace): Promise<void> {
    await this.db
      .prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)')
      .bind(workspace.id, workspace.name, workspace.createdAt)
      .run()
  }

  async delete(id: string): Promise<void> {
    // Cascade explicitly: D1 does not enforce foreign keys by default.
    await this.db.batch([
      this.db.prepare('DELETE FROM executions WHERE workspace_id = ?').bind(id),
      this.db.prepare('DELETE FROM blocks WHERE workspace_id = ?').bind(id),
      this.db.prepare('DELETE FROM pipelines WHERE workspace_id = ?').bind(id),
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').bind(id),
    ])
  }
}

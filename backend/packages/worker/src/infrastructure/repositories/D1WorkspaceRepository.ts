import type { WorkspaceRepository } from '@cat-factory/core'
import type { Workspace } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type WorkspaceRow, rowToWorkspace } from './mappers'

export class D1WorkspaceRepository implements WorkspaceRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByOwner(ownerUserId: number | null): Promise<Workspace[]> {
    // A null owner means auth is disabled — return every board (legacy behaviour).
    // A numeric owner scopes to that user; legacy NULL-owner rows are excluded.
    const { results } = await (
      ownerUserId === null
        ? this.db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC')
        : this.db
            .prepare('SELECT * FROM workspaces WHERE owner_user_id = ? ORDER BY created_at DESC')
            .bind(ownerUserId)
    ).all<WorkspaceRow>()
    return results.map(rowToWorkspace)
  }

  async get(id: string): Promise<Workspace | null> {
    const row = await this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .bind(id)
      .first<WorkspaceRow>()
    return row ? rowToWorkspace(row) : null
  }

  async ownerOf(id: string): Promise<number | null | undefined> {
    const row = await this.db
      .prepare('SELECT owner_user_id FROM workspaces WHERE id = ?')
      .bind(id)
      .first<{ owner_user_id: number | null }>()
    // Row absent → undefined (missing); present → the (possibly null) owner id.
    return row ? row.owner_user_id : undefined
  }

  async create(workspace: Workspace, ownerUserId: number | null): Promise<void> {
    await this.db
      .prepare('INSERT INTO workspaces (id, name, created_at, owner_user_id) VALUES (?, ?, ?, ?)')
      .bind(workspace.id, workspace.name, workspace.createdAt, ownerUserId)
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

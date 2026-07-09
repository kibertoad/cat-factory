import type { WorkspaceRepository, WorkspaceVisibility } from '@cat-factory/kernel'
import type { Workspace } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type WorkspaceRow, rowToWorkspace } from './mappers'

export class D1WorkspaceRepository implements WorkspaceRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listVisible(scope: WorkspaceVisibility): Promise<Workspace[]> {
    // A null scope means auth is disabled — return every board (dev behaviour).
    if (scope === null) {
      const { results } = await this.db
        .prepare('SELECT * FROM workspaces ORDER BY created_at DESC')
        .all<WorkspaceRow>()
      return results.map(rowToWorkspace)
    }
    // A signed-in user sees boards in any account they belong to, plus any legacy
    // board they personally own (account_id NULL, owner_user_id = them).
    const placeholders = scope.accountIds.map(() => '?').join(', ')
    const accountClause = scope.accountIds.length > 0 ? `account_id IN (${placeholders})` : '0'
    const { results } = await this.db
      .prepare(
        `SELECT * FROM workspaces
          WHERE ${accountClause}
             OR (account_id IS NULL AND owner_user_id = ?)
          ORDER BY created_at DESC`,
      )
      .bind(...scope.accountIds, scope.ownerUserId)
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

  async ownerOf(id: string): Promise<string | null | undefined> {
    const row = await this.db
      .prepare('SELECT owner_user_id FROM workspaces WHERE id = ?')
      .bind(id)
      .first<{ owner_user_id: string | null }>()
    // Row absent → undefined (missing); present → the (possibly null) owner id.
    return row ? row.owner_user_id : undefined
  }

  async accountOf(id: string): Promise<string | null | undefined> {
    const row = await this.db
      .prepare('SELECT account_id FROM workspaces WHERE id = ?')
      .bind(id)
      .first<{ account_id: string | null }>()
    // Row absent → undefined (missing); present → the (possibly null) account id.
    return row ? row.account_id : undefined
  }

  async create(
    workspace: Workspace,
    ownerUserId: string | null,
    accountId: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO workspaces (id, name, description, created_at, owner_user_id, account_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        workspace.id,
        workspace.name,
        workspace.description ?? null,
        workspace.createdAt,
        ownerUserId,
        accountId,
      )
      .run()
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').bind(name, id).run()
  }

  async setDescription(id: string, description: string | null): Promise<void> {
    await this.db
      .prepare('UPDATE workspaces SET description = ? WHERE id = ?')
      .bind(description, id)
      .run()
  }

  async delete(id: string): Promise<void> {
    // Cascade explicitly: D1 does not enforce foreign keys by default. The service/mount rows
    // MUST be reclaimed BEFORE the blocks they reference are dropped (their subqueries read
    // `blocks`). A deleted board that leaves its account-owned services behind is not a cosmetic
    // leak: `services` is account-scoped and looked up by (installation_id, repo_github_id), so a
    // dangling service (its frame block gone) keeps the SAME repo from being re-added on any other
    // board in the account — the exact "already linked / already exists" failure a board delete
    // used to cause. Mirror any change in the Node facade's DrizzleWorkspaceRepository.delete.
    await this.db.batch([
      // Every board's mount of a service this workspace HOMES (its frame block lives here).
      this.db
        .prepare(
          `DELETE FROM workspace_services WHERE service_id IN
             (SELECT id FROM services WHERE frame_block_id IN
               (SELECT id FROM blocks WHERE workspace_id = ?))`,
        )
        .bind(id),
      // This workspace's OWN mounts of services homed elsewhere (shared services it mounted).
      this.db.prepare('DELETE FROM workspace_services WHERE workspace_id = ?').bind(id),
      // The account-owned services this workspace homes — the repo↔frame link that must be freed.
      this.db
        .prepare(
          'DELETE FROM services WHERE frame_block_id IN (SELECT id FROM blocks WHERE workspace_id = ?)',
        )
        .bind(id),
      this.db.prepare('DELETE FROM environments WHERE workspace_id = ?').bind(id),
      // agent_runs holds both execution and bootstrap runs (migration 0019).
      this.db.prepare('DELETE FROM agent_runs WHERE workspace_id = ?').bind(id),
      this.db.prepare('DELETE FROM blocks WHERE workspace_id = ?').bind(id),
      this.db.prepare('DELETE FROM pipelines WHERE workspace_id = ?').bind(id),
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').bind(id),
    ])
  }
}

import type {
  ServiceRehome,
  WorkspaceAccessRow,
  WorkspaceRepository,
  WorkspaceVisibility,
} from '@cat-factory/kernel'
import { WORKSPACE_SCOPED_TABLES } from '@cat-factory/kernel'
import type { Workspace, WorkspaceAccessMode } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type WorkspaceRow, rowToWorkspace } from './mappers'

// Cloudflare-only workspace-scoped tables that have no Node/Drizzle analogue (Durable-Object
// tracking), appended to the shared cascade list for this facade. Kept here — not in the
// runtime-neutral kernel list — so the Node cascade never references a table it lacks.
// Exported so the D1-side cascade-completeness guard (workspace-cascade-completeness.spec.ts)
// asserts coverage against the SAME source of truth the delete iterates — the Node/Drizzle
// completeness spec can't see these facade-only tables, so this is what closes that gap.
export const D1_ONLY_WORKSPACE_SCOPED_TABLES = ['live_containers'] as const

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
    // A signed-in user sees, resolved SQL-side (see WorkspaceVisibility): unrestricted
    // boards in accounts they belong to, ANY board in accounts they admin (escape hatch),
    // boards they hold an explicit member row on (ANDed with their account ids so an
    // orphaned foreign-account row can't resurface), and legacy boards they personally own.
    const inList = (ids: string[]) => ids.map(() => '?').join(', ')
    const clauses: string[] = []
    const binds: string[] = []
    if (scope.accountIds.length > 0) {
      clauses.push(`(account_id IN (${inList(scope.accountIds)}) AND access_mode = 'account')`)
      binds.push(...scope.accountIds)
    }
    if (scope.adminAccountIds.length > 0) {
      clauses.push(`account_id IN (${inList(scope.adminAccountIds)})`)
      binds.push(...scope.adminAccountIds)
    }
    if (scope.accountIds.length > 0) {
      clauses.push(
        `(account_id IN (${inList(scope.accountIds)}) AND id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?))`,
      )
      binds.push(...scope.accountIds, scope.userId)
    }
    clauses.push('(account_id IS NULL AND owner_user_id = ?)')
    binds.push(scope.ownerUserId)
    const { results } = await this.db
      .prepare(`SELECT * FROM workspaces WHERE ${clauses.join(' OR ')} ORDER BY created_at DESC`)
      .bind(...binds)
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

  async accessRowOf(id: string): Promise<WorkspaceAccessRow | undefined> {
    const row = await this.db
      .prepare('SELECT account_id, owner_user_id, access_mode FROM workspaces WHERE id = ?')
      .bind(id)
      .first<{
        account_id: string | null
        owner_user_id: string | null
        access_mode: string | null
      }>()
    if (!row) return undefined
    return {
      accountId: row.account_id,
      ownerUserId: row.owner_user_id,
      accessMode: row.access_mode === 'restricted' ? 'restricted' : 'account',
    }
  }

  async setAccessMode(id: string, mode: WorkspaceAccessMode): Promise<void> {
    await this.db.prepare('UPDATE workspaces SET access_mode = ? WHERE id = ?').bind(mode, id).run()
  }

  async linkAccount(id: string, accountId: string): Promise<void> {
    await this.db
      .prepare('UPDATE workspaces SET account_id = ? WHERE id = ?')
      .bind(accountId, id)
      .run()
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

  async delete(id: string, rehome: ServiceRehome[] = []): Promise<void> {
    // Cascade explicitly: D1 does not enforce foreign keys by default. The service/mount rows
    // MUST be reclaimed BEFORE the blocks they reference are dropped (their subqueries read
    // `blocks`). A deleted board that leaves its account-owned services behind is not a cosmetic
    // leak: `services` is account-scoped and looked up by (installation_id, repo_github_id), so a
    // dangling service (its frame block gone) keeps the SAME repo from being re-added on any other
    // board in the account — the exact "already linked / already exists" failure a board delete
    // used to cause. Mirror any change in the Node facade's DrizzleWorkspaceRepository.delete.
    //
    // Re-home FIRST (before the cascade reads `blocks`): move each shared service's blocks + run
    // history to a surviving mounting board by re-stamping their `workspace_id`. Blocks are found
    // by `service_id` (not workspace), so after the move the service's frame no longer lives in
    // THIS workspace — the cascade below then skips it (its frame is not in this board's blocks),
    // leaving the service, its subtree and every OTHER board's mount intact.
    const rehomeStatements = rehome.flatMap(({ serviceId, toWorkspaceId }) => [
      this.db
        .prepare(
          `UPDATE agent_runs SET workspace_id = ? WHERE block_id IN
             (SELECT id FROM blocks WHERE service_id = ?)`,
        )
        .bind(toWorkspaceId, serviceId),
      this.db
        .prepare('UPDATE blocks SET workspace_id = ? WHERE service_id = ?')
        .bind(toWorkspaceId, serviceId),
    ])
    // The bulk reclaim of every plain workspace-scoped table is driven by the shared kernel
    // list (WORKSPACE_SCOPED_TABLES) so this facade and the Node facade cannot drift and a new
    // table can't silently miss the cascade — see backend/packages/kernel/.../workspace-cascade.ts.
    // These have no inter-table FK ordering constraints, but MUST run AFTER the `services`/mount
    // reclaim below (which reads `blocks`) and BEFORE the root `workspaces` row is dropped.
    const bulkDeletes = [...WORKSPACE_SCOPED_TABLES, ...D1_ONLY_WORKSPACE_SCOPED_TABLES].map(
      (table) => this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(id),
    )
    await this.db.batch([
      ...rehomeStatements,
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
      // MUST precede the `blocks` delete in the bulk list (this subquery reads `blocks`).
      this.db
        .prepare(
          'DELETE FROM services WHERE frame_block_id IN (SELECT id FROM blocks WHERE workspace_id = ?)',
        )
        .bind(id),
      // Bulk reclaim of every plain workspace-scoped table (incl. blocks/agent_runs/pipelines/
      // environments — agent_runs holds both execution and bootstrap runs, migration 0019).
      ...bulkDeletes,
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').bind(id),
    ])
  }
}

import type {
  WorkspaceMemberRecord,
  WorkspaceMemberRepository,
  WorkspaceRole,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface WorkspaceMemberRow {
  workspace_id: string
  user_id: string
  role: string | null
  created_at: number
  added_by_user_id: string | null
}

/** Coerce a stored role string to a valid {@link WorkspaceRole}, defaulting to viewer. */
function parseRole(role: string | null): WorkspaceRole {
  return role === 'admin' || role === 'member' || role === 'viewer' ? role : 'viewer'
}

function rowToMember(row: WorkspaceMemberRow): WorkspaceMemberRecord {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: parseRole(row.role),
    createdAt: row.created_at,
    addedByUserId: row.added_by_user_id,
  }
}

/** D1-backed store of workspace memberships (workspace RBAC; migration 0052). */
export class D1WorkspaceMemberRepository implements WorkspaceMemberRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .bind(workspaceId, userId)
      .first<WorkspaceMemberRow>()
    return row ? rowToMember(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY created_at ASC')
      .bind(workspaceId)
      .all<WorkspaceMemberRow>()
    return results.map(rowToMember)
  }

  async listWorkspaceIdsForUser(userId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?')
      .bind(userId)
      .all<{ workspace_id: string }>()
    return results.map((r) => r.workspace_id)
  }

  async getRolesForUserInWorkspaces(
    userId: string,
    workspaceIds: string[],
  ): Promise<Map<string, WorkspaceRole>> {
    const out = new Map<string, WorkspaceRole>()
    if (workspaceIds.length === 0) return out
    // ONE chunked-IN read per chunk (never a per-board point-read loop).
    for (let i = 0; i < workspaceIds.length; i += 500) {
      const chunk = workspaceIds.slice(i, i + 500)
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT workspace_id, role FROM workspace_members
             WHERE user_id = ? AND workspace_id IN (${placeholders})`,
        )
        .bind(userId, ...chunk)
        .all<{ workspace_id: string; role: string | null }>()
      for (const r of results) out.set(r.workspace_id, parseRole(r.role))
    }
    return out
  }

  async upsert(member: WorkspaceMemberRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at, added_by_user_id)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(member.workspaceId, member.userId, member.role, member.createdAt, member.addedByUserId)
      .run()
  }

  async remove(workspaceId: string, userId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .bind(workspaceId, userId)
      .run()
  }

  async removeByAccountMembership(accountId: string, userId: string): Promise<number> {
    // One DELETE joined on the owning account — drop every membership this user holds in
    // boards of `accountId`. D1 has no `DELETE ... USING`, so scope by subquery.
    const result = await this.db
      .prepare(
        `DELETE FROM workspace_members
           WHERE user_id = ?
             AND workspace_id IN (SELECT id FROM workspaces WHERE account_id = ?)`,
      )
      .bind(userId, accountId)
      .run()
    return result.meta.changes ?? 0
  }
}

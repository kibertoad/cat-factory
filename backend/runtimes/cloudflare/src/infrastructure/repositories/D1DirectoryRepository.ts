import {
  type DirectoryChangeRecord,
  type DirectoryRepoKey,
  type DirectoryRepository,
  directoryChangeFromRow,
  type StoredDirectoryChange,
  WORKSPACE_DIRECTORY_ENTITY_TYPES,
  type WorkspaceMembershipKey,
} from '@cat-factory/kernel'
import {
  type DirectoryAccountMembership,
  type DirectoryRepo,
  type DirectoryUser,
  type DirectoryWorkspace,
  type DirectoryWorkspaceMembership,
} from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'
import { parseRoles } from './D1MembershipRepository'

// The directory read side over D1 (docs/initiatives/directory-sync.md). Mirror of the Node
// facade's `DrizzleDirectoryRepository`; `defineDirectoryFeedSuite` and
// `defineDirectoryReadSuite` hold the two to one behaviour. The feed rows themselves are appended
// by the writing repositories through `directoryFeed.ts`.

interface WorkspaceRow {
  id: string
  name: string
  description: string | null
  access_mode: string | null
}

interface UserRow {
  id: string
  name: string | null
  email: string | null
  avatar_url: string | null
}

interface AccountMembershipRow {
  user_id: string
  roles: string | null
  created_at: number
}

interface WorkspaceMembershipRow {
  workspace_id: string
  user_id: string
  role: string | null
  created_at: number
}

interface RepoRow {
  workspace_id: string
  github_id: number
  provider: string | null
  owner: string
  name: string
  default_branch: string | null
  private: number
  is_monorepo: number
}

const toWorkspace = (row: WorkspaceRow): DirectoryWorkspace => ({
  id: row.id,
  name: row.name,
  description: row.description,
  accessMode: row.access_mode === 'restricted' ? 'restricted' : 'account',
})

const toUser = (row: UserRow): DirectoryUser => ({
  id: row.id,
  name: row.name,
  email: row.email,
  avatarUrl: row.avatar_url,
})

const toAccountMembership = (row: AccountMembershipRow): DirectoryAccountMembership => ({
  userId: row.user_id,
  roles: parseRoles(row.roles),
  createdAt: row.created_at,
})

const toWorkspaceMembership = (row: WorkspaceMembershipRow): DirectoryWorkspaceMembership => ({
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role === 'admin' || row.role === 'member' ? row.role : 'viewer',
  createdAt: row.created_at,
})

const toRepo = (row: RepoRow): DirectoryRepo => ({
  workspaceId: row.workspace_id,
  repoId: row.github_id,
  provider: row.provider === 'gitlab' ? 'gitlab' : 'github',
  owner: row.owner,
  name: row.name,
  defaultBranch: row.default_branch,
  private: row.private === 1,
  monorepo: row.is_monorepo === 1,
})

/** `AND <column> IN (...)` for a workspace reach, or nothing for an unrestricted one. */
function reachClause(
  column: string,
  workspaceIds: string[] | null,
): { sql: string; binds: string[] } {
  if (workspaceIds === null) return { sql: '', binds: [] }
  if (workspaceIds.length === 0) return { sql: ' AND 0 = 1', binds: [] }
  return {
    sql: ` AND ${column} IN (${workspaceIds.map(() => '?').join(', ')})`,
    binds: workspaceIds,
  }
}

export class D1DirectoryRepository implements DirectoryRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listChanges(
    accountId: string,
    afterSeq: number,
    upToSeq: number,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryChangeRecord[]> {
    // A restricted key reads its workspaces' changes plus the deletion of ANY workspace that no
    // longer exists: deleting a board also drops the key's grant on it, so without the second arm
    // the key would never learn that a board it mirrored is gone.
    const reach = reachClause('workspace_id', workspaceIds)
    const restricted =
      workspaceIds === null
        ? { sql: '', binds: [] as string[] }
        : {
            sql: ` AND ((entity_type IN (${WORKSPACE_DIRECTORY_ENTITY_TYPES.map(() => '?').join(', ')})${reach.sql})
                    OR (entity_type = 'workspace'
                        AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = directory_changes.entity_id)))`,
            binds: [...WORKSPACE_DIRECTORY_ENTITY_TYPES, ...reach.binds],
          }
    const { results } = await this.db
      .prepare(
        `SELECT * FROM directory_changes
          WHERE account_id = ? AND seq > ? AND seq <= ?${restricted.sql}
          ORDER BY seq ASC LIMIT ?`,
      )
      .bind(accountId, afterSeq, upToSeq, ...restricted.binds, limit)
      .all<StoredDirectoryChange>()
    return results.map(directoryChangeFromRow)
  }

  async headSeq(accountId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT MAX(seq) AS head FROM directory_changes WHERE account_id = ?')
      .bind(accountId)
      .first<{ head: number | null }>()
    return row?.head ?? 0
  }

  async headSeqs(accountIds: string[]): Promise<Map<string, number>> {
    const heads = new Map(accountIds.map((id) => [id, 0]))
    for (const chunk of chunkForIn(accountIds)) {
      const { results } = await this.db
        .prepare(
          `SELECT account_id, MAX(seq) AS head FROM directory_changes
            WHERE account_id IN (${chunk.map(() => '?').join(', ')}) GROUP BY account_id`,
        )
        .bind(...chunk)
        .all<{ account_id: string; head: number }>()
      for (const row of results ?? []) heads.set(row.account_id, row.head)
    }
    return heads
  }

  async oldestSeq(accountId: string): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT MIN(seq) AS oldest FROM directory_changes WHERE account_id = ?')
      .bind(accountId)
      .first<{ oldest: number | null }>()
    return row?.oldest ?? null
  }

  async pruneChanges(before: number): Promise<number> {
    // A `seq` PREFIX per account, up to its newest row older than the cutoff. `at` is not monotonic
    // in `seq` (a writer stamps it before waiting on the feed's ordering), so deleting by `at` alone
    // could remove a row while keeping an older-`seq` one, leaving a hole behind the oldest row that
    // the reader's expiry check cannot see.
    const result = await this.db
      .prepare(
        `WITH cut AS (SELECT account_id, MAX(seq) AS upto FROM directory_changes
                       WHERE at < ? GROUP BY account_id)
         DELETE FROM directory_changes
          WHERE account_id IN (SELECT account_id FROM cut)
            AND seq <= (SELECT upto FROM cut WHERE cut.account_id = directory_changes.account_id)
            AND seq < (SELECT MAX(d.seq) FROM directory_changes d
                        WHERE d.account_id = directory_changes.account_id)`,
      )
      .bind(before)
      .run()
    return result.meta.changes ?? 0
  }

  async listWorkspaces(
    accountId: string,
    after: string | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryWorkspace[]> {
    const reach = reachClause('id', workspaceIds)
    const { results } = await this.db
      .prepare(
        `SELECT id, name, description, access_mode FROM workspaces
          WHERE account_id = ? AND id > ?${reach.sql}
          ORDER BY id ASC LIMIT ?`,
      )
      .bind(accountId, after ?? '', ...reach.binds, limit)
      .all<WorkspaceRow>()
    return results.map(toWorkspace)
  }

  async listUsers(
    accountId: string,
    after: string | null,
    limit: number,
  ): Promise<DirectoryUser[]> {
    const { results } = await this.db
      .prepare(
        `SELECT u.id, u.name, u.email, u.avatar_url FROM users u
           JOIN memberships m ON m.user_id = u.id
          WHERE m.account_id = ? AND u.id > ?
          ORDER BY u.id ASC LIMIT ?`,
      )
      .bind(accountId, after ?? '', limit)
      .all<UserRow>()
    return results.map(toUser)
  }

  async listAccountMemberships(
    accountId: string,
    after: string | null,
    limit: number,
  ): Promise<DirectoryAccountMembership[]> {
    const { results } = await this.db
      .prepare(
        `SELECT user_id, roles, created_at FROM memberships
          WHERE account_id = ? AND user_id > ?
          ORDER BY user_id ASC LIMIT ?`,
      )
      .bind(accountId, after ?? '', limit)
      .all<AccountMembershipRow>()
    return results.map(toAccountMembership)
  }

  async listWorkspaceMemberships(
    accountId: string,
    after: WorkspaceMembershipKey | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryWorkspaceMembership[]> {
    const reach = reachClause('m.workspace_id', workspaceIds)
    const { results } = await this.db
      .prepare(
        `SELECT m.workspace_id, m.user_id, m.role, m.created_at
           FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
          WHERE w.account_id = ?
            AND (m.workspace_id > ? OR (m.workspace_id = ? AND m.user_id > ?))${reach.sql}
          ORDER BY m.workspace_id ASC, m.user_id ASC LIMIT ?`,
      )
      .bind(
        accountId,
        after?.workspaceId ?? '',
        after?.workspaceId ?? '',
        after?.userId ?? '',
        ...reach.binds,
        limit,
      )
      .all<WorkspaceMembershipRow>()
    return results.map(toWorkspaceMembership)
  }

  async listRepos(
    accountId: string,
    after: DirectoryRepoKey | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryRepo[]> {
    const reach = reachClause('r.workspace_id', workspaceIds)
    const { results } = await this.db
      .prepare(
        `SELECT r.workspace_id, r.github_id, r.provider, r.owner, r.name, r.default_branch,
                r.private, r.is_monorepo
           FROM github_repos r JOIN workspaces w ON w.id = r.workspace_id
          WHERE w.account_id = ? AND r.deleted_at IS NULL
            AND (r.workspace_id > ? OR (r.workspace_id = ? AND r.github_id > ?))${reach.sql}
          ORDER BY r.workspace_id ASC, r.github_id ASC LIMIT ?`,
      )
      .bind(
        accountId,
        after?.workspaceId ?? '',
        after?.workspaceId ?? '',
        after?.repoId ?? -1,
        ...reach.binds,
        limit,
      )
      .all<RepoRow>()
    return results.map(toRepo)
  }

  async getWorkspaces(accountId: string, ids: string[]): Promise<DirectoryWorkspace[]> {
    const out: DirectoryWorkspace[] = []
    for (const chunk of chunkForIn(ids)) {
      const { results } = await this.db
        .prepare(
          `SELECT id, name, description, access_mode FROM workspaces
            WHERE account_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .bind(accountId, ...chunk)
        .all<WorkspaceRow>()
      out.push(...results.map(toWorkspace))
    }
    return out
  }

  async getUsers(accountId: string, ids: string[]): Promise<DirectoryUser[]> {
    const out: DirectoryUser[] = []
    for (const chunk of chunkForIn(ids)) {
      const { results } = await this.db
        .prepare(
          `SELECT u.id, u.name, u.email, u.avatar_url FROM users u
             JOIN memberships m ON m.user_id = u.id
            WHERE m.account_id = ? AND u.id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .bind(accountId, ...chunk)
        .all<UserRow>()
      out.push(...results.map(toUser))
    }
    return out
  }

  async getAccountMemberships(
    accountId: string,
    userIds: string[],
  ): Promise<DirectoryAccountMembership[]> {
    const out: DirectoryAccountMembership[] = []
    for (const chunk of chunkForIn(userIds)) {
      const { results } = await this.db
        .prepare(
          `SELECT user_id, roles, created_at FROM memberships
            WHERE account_id = ? AND user_id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .bind(accountId, ...chunk)
        .all<AccountMembershipRow>()
      out.push(...results.map(toAccountMembership))
    }
    return out
  }

  async getWorkspaceMemberships(
    accountId: string,
    keys: WorkspaceMembershipKey[],
  ): Promise<DirectoryWorkspaceMembership[]> {
    const out: DirectoryWorkspaceMembership[] = []
    for (const chunk of chunkForIn(keys, 2)) {
      const match = chunk.map(() => '(m.workspace_id = ? AND m.user_id = ?)').join(' OR ')
      const { results } = await this.db
        .prepare(
          `SELECT m.workspace_id, m.user_id, m.role, m.created_at
             FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
            WHERE w.account_id = ? AND (${match})`,
        )
        .bind(accountId, ...chunk.flatMap((k) => [k.workspaceId, k.userId]))
        .all<WorkspaceMembershipRow>()
      out.push(...results.map(toWorkspaceMembership))
    }
    return out
  }

  async getRepos(accountId: string, keys: DirectoryRepoKey[]): Promise<DirectoryRepo[]> {
    const out: DirectoryRepo[] = []
    for (const chunk of chunkForIn(keys, 2)) {
      const match = chunk.map(() => '(r.workspace_id = ? AND r.github_id = ?)').join(' OR ')
      const { results } = await this.db
        .prepare(
          `SELECT r.workspace_id, r.github_id, r.provider, r.owner, r.name, r.default_branch,
                  r.private, r.is_monorepo
             FROM github_repos r JOIN workspaces w ON w.id = r.workspace_id
            WHERE w.account_id = ? AND r.deleted_at IS NULL AND (${match})`,
        )
        .bind(accountId, ...chunk.flatMap((k) => [k.workspaceId, k.repoId]))
        .all<RepoRow>()
      out.push(...results.map(toRepo))
    }
    return out
  }
}

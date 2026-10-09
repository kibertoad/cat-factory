import type {
  DirectoryChangeRecord,
  DirectoryRepoKey,
  DirectoryRepository,
  WorkspaceMembershipKey,
} from '@cat-factory/kernel'
import {
  type AccountRole,
  type DirectoryAccountMembership,
  type DirectoryRepo,
  type DirectoryUser,
  type DirectoryWorkspace,
  type DirectoryWorkspaceMembership,
  isDirectoryEntityType,
} from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

// The directory read side over D1 (backend/docs/adr/0067-directory-sync.md). Mirror of the Node
// facade's `DrizzleDirectoryRepository`; `defineDirectoryFeedSuite` and
// `defineDirectoryReadSuite` hold the two to one behaviour. The feed rows themselves are appended
// by the writing repositories through `directoryFeed.ts`.

interface ChangeRow {
  account_id: string
  seq: number
  entity_type: string
  workspace_id: string | null
  entity_id: string
  at: number
}

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

/** The entity types a key limited to some workspaces may read. */
const WORKSPACE_ENTITY_TYPES = ['workspace', 'workspace_membership', 'repo']

function rowToChange(row: ChangeRow): DirectoryChangeRecord {
  // The vocabulary is append-only, so an unknown value is a row this build cannot interpret, not
  // one to skip: a reader that dropped it would advance its cursor past a change it never served.
  if (!isDirectoryEntityType(row.entity_type)) {
    throw new Error(`Unknown directory entity type '${row.entity_type}' at seq ${row.seq}`)
  }
  return {
    accountId: row.account_id,
    seq: row.seq,
    entityType: row.entity_type,
    workspaceId: row.workspace_id,
    entityId: row.entity_id,
    at: row.at,
  }
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

function parseRoles(csv: string | null): AccountRole[] {
  const roles = (csv ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is AccountRole => r === 'admin' || r === 'developer' || r === 'product')
  return roles.length > 0 ? [...new Set(roles)] : ['developer']
}

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
    const reach = reachClause('workspace_id', workspaceIds)
    const types =
      workspaceIds === null
        ? ''
        : ` AND entity_type IN (${WORKSPACE_ENTITY_TYPES.map(() => '?').join(', ')})`
    const { results } = await this.db
      .prepare(
        `SELECT * FROM directory_changes
          WHERE account_id = ? AND seq > ? AND seq <= ?${types}${reach.sql}
          ORDER BY seq ASC LIMIT ?`,
      )
      .bind(
        accountId,
        afterSeq,
        upToSeq,
        ...(workspaceIds === null ? [] : WORKSPACE_ENTITY_TYPES),
        ...reach.binds,
        limit,
      )
      .all<ChangeRow>()
    return results.map(rowToChange)
  }

  async headSeq(accountId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT MAX(seq) AS head FROM directory_changes WHERE account_id = ?')
      .bind(accountId)
      .first<{ head: number | null }>()
    return row?.head ?? 0
  }

  async oldestSeq(accountId: string): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT MIN(seq) AS oldest FROM directory_changes WHERE account_id = ?')
      .bind(accountId)
      .first<{ oldest: number | null }>()
    return row?.oldest ?? null
  }

  async pruneChanges(before: number): Promise<number> {
    const result = await this.db
      .prepare(
        `DELETE FROM directory_changes
          WHERE at < ?
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

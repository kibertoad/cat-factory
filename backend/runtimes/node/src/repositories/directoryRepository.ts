import {
  type DirectoryAccountMembership,
  type DirectoryRepo,
  type DirectoryUser,
  type DirectoryWorkspace,
  type DirectoryWorkspaceMembership,
} from '@cat-factory/contracts'
import {
  type DirectoryChangeRecord,
  type DirectoryRepoKey,
  type DirectoryRepository,
  directoryChangeFromRow,
  WORKSPACE_DIRECTORY_ENTITY_TYPES,
  type WorkspaceMembershipKey,
} from '@cat-factory/kernel'
import { type SQL, and, asc, eq, gt, inArray, isNull, lte, max, min, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { DrizzleDb } from '../db/client.js'
import {
  directoryChanges,
  githubRepos,
  memberships,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js'
import { parseRoles } from './drizzle/accounts.js'

// The directory read side over Postgres (backend/docs/adr/0067-directory-sync.md). Mirror of the
// Cloudflare facade's `D1DirectoryRepository`; `defineDirectoryFeedSuite` and
// `defineDirectoryReadSuite` hold the two to one behaviour. The feed rows themselves are appended
// by the writing repositories through `directoryFeed.ts`.

const workspaceColumns = {
  id: workspaces.id,
  name: workspaces.name,
  description: workspaces.description,
  accessMode: workspaces.access_mode,
}

function toWorkspace(row: {
  id: string
  name: string
  description: string | null
  accessMode: string | null
}): DirectoryWorkspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    accessMode: row.accessMode === 'restricted' ? 'restricted' : 'account',
  }
}

const userColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  avatarUrl: users.avatar_url,
}

const accountMembershipColumns = {
  userId: memberships.user_id,
  roles: memberships.roles,
  createdAt: memberships.created_at,
}

function toAccountMembership(row: {
  userId: string
  roles: string | null
  createdAt: number
}): DirectoryAccountMembership {
  return { userId: row.userId, roles: parseRoles(row.roles), createdAt: row.createdAt }
}

const workspaceMembershipColumns = {
  workspaceId: workspaceMembers.workspace_id,
  userId: workspaceMembers.user_id,
  role: workspaceMembers.role,
  createdAt: workspaceMembers.created_at,
}

function toWorkspaceMembership(row: {
  workspaceId: string
  userId: string
  role: string | null
  createdAt: number
}): DirectoryWorkspaceMembership {
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role === 'admin' || row.role === 'member' ? row.role : 'viewer',
    createdAt: row.createdAt,
  }
}

const repoColumns = {
  workspaceId: githubRepos.workspace_id,
  repoId: githubRepos.github_id,
  provider: githubRepos.provider,
  owner: githubRepos.owner,
  name: githubRepos.name,
  defaultBranch: githubRepos.default_branch,
  private: githubRepos.private,
  isMonorepo: githubRepos.is_monorepo,
}

function toRepo(row: {
  workspaceId: string
  repoId: number
  provider: string | null
  owner: string
  name: string
  defaultBranch: string | null
  private: number
  isMonorepo: number
}): DirectoryRepo {
  return {
    workspaceId: row.workspaceId,
    repoId: row.repoId,
    provider: row.provider === 'gitlab' ? 'gitlab' : 'github',
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
    private: row.private === 1,
    monorepo: row.isMonorepo === 1,
  }
}

/** A workspace reach as a predicate on `column`, or none for an unrestricted key. */
function reach(column: AnyPgColumn, workspaceIds: string[] | null): SQL | undefined {
  if (workspaceIds === null) return undefined
  if (workspaceIds.length === 0) return sql`false`
  return inArray(column, workspaceIds)
}

export class DrizzleDirectoryRepository implements DirectoryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listChanges(
    accountId: string,
    afterSeq: number,
    upToSeq: number,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryChangeRecord[]> {
    const rows = await this.db
      .select()
      .from(directoryChanges)
      .where(
        and(
          eq(directoryChanges.account_id, accountId),
          gt(directoryChanges.seq, afterSeq),
          lte(directoryChanges.seq, upToSeq),
          // A restricted key reads its workspaces' changes plus the deletion of ANY workspace that
          // no longer exists: deleting a board also drops the key's grant on it, so without the
          // second arm the key would never learn that a board it mirrored is gone.
          workspaceIds === null
            ? undefined
            : or(
                and(
                  inArray(directoryChanges.entity_type, [...WORKSPACE_DIRECTORY_ENTITY_TYPES]),
                  reach(directoryChanges.workspace_id, workspaceIds),
                ),
                and(
                  eq(directoryChanges.entity_type, 'workspace'),
                  sql`NOT EXISTS (SELECT 1 FROM ${workspaces} WHERE ${workspaces.id} = ${directoryChanges.entity_id})`,
                ),
              ),
        ),
      )
      .orderBy(asc(directoryChanges.seq))
      .limit(limit)
    return rows.map(directoryChangeFromRow)
  }

  async headSeq(accountId: string): Promise<number> {
    const [row] = await this.db
      .select({ head: max(directoryChanges.seq) })
      .from(directoryChanges)
      .where(eq(directoryChanges.account_id, accountId))
    return row?.head ?? 0
  }

  async headSeqs(accountIds: string[]): Promise<Map<string, number>> {
    const heads = new Map(accountIds.map((id) => [id, 0]))
    if (accountIds.length === 0) return heads
    const rows = await this.db
      .select({ accountId: directoryChanges.account_id, head: max(directoryChanges.seq) })
      .from(directoryChanges)
      .where(inArray(directoryChanges.account_id, accountIds))
      .groupBy(directoryChanges.account_id)
    for (const row of rows) heads.set(row.accountId, row.head ?? 0)
    return heads
  }

  async oldestSeq(accountId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ oldest: min(directoryChanges.seq) })
      .from(directoryChanges)
      .where(eq(directoryChanges.account_id, accountId))
    return row?.oldest ?? null
  }

  async pruneChanges(before: number): Promise<number> {
    // A `seq` PREFIX per account, up to its newest row older than the cutoff. `at` is not monotonic
    // in `seq` (a writer stamps it before taking the feed's advisory lock), so deleting by `at`
    // alone could remove a row while keeping an older-`seq` one, leaving a hole behind the oldest
    // row that the reader's expiry check cannot see.
    const result = await this.db.execute(sql`
      WITH cut AS (SELECT account_id, MAX(seq) AS upto FROM directory_changes
                    WHERE at < ${before} GROUP BY account_id)
      DELETE FROM directory_changes c USING cut
       WHERE c.account_id = cut.account_id
         AND c.seq <= cut.upto
         AND c.seq < (SELECT MAX(d.seq) FROM directory_changes d
                       WHERE d.account_id = c.account_id)`)
    return result.rowCount ?? 0
  }

  async listWorkspaces(
    accountId: string,
    after: string | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryWorkspace[]> {
    const rows = await this.db
      .select(workspaceColumns)
      .from(workspaces)
      .where(
        and(
          eq(workspaces.account_id, accountId),
          gt(workspaces.id, after ?? ''),
          reach(workspaces.id, workspaceIds),
        ),
      )
      .orderBy(asc(workspaces.id))
      .limit(limit)
    return rows.map(toWorkspace)
  }

  async listUsers(
    accountId: string,
    after: string | null,
    limit: number,
  ): Promise<DirectoryUser[]> {
    return this.db
      .select(userColumns)
      .from(users)
      .innerJoin(memberships, eq(memberships.user_id, users.id))
      .where(and(eq(memberships.account_id, accountId), gt(users.id, after ?? '')))
      .orderBy(asc(users.id))
      .limit(limit)
  }

  async listAccountMemberships(
    accountId: string,
    after: string | null,
    limit: number,
  ): Promise<DirectoryAccountMembership[]> {
    const rows = await this.db
      .select(accountMembershipColumns)
      .from(memberships)
      .where(and(eq(memberships.account_id, accountId), gt(memberships.user_id, after ?? '')))
      .orderBy(asc(memberships.user_id))
      .limit(limit)
    return rows.map(toAccountMembership)
  }

  async listWorkspaceMemberships(
    accountId: string,
    after: WorkspaceMembershipKey | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryWorkspaceMembership[]> {
    const rows = await this.db
      .select(workspaceMembershipColumns)
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspace_id))
      .where(
        and(
          eq(workspaces.account_id, accountId),
          after === null
            ? undefined
            : or(
                gt(workspaceMembers.workspace_id, after.workspaceId),
                and(
                  eq(workspaceMembers.workspace_id, after.workspaceId),
                  gt(workspaceMembers.user_id, after.userId),
                ),
              ),
          reach(workspaceMembers.workspace_id, workspaceIds),
        ),
      )
      .orderBy(asc(workspaceMembers.workspace_id), asc(workspaceMembers.user_id))
      .limit(limit)
    return rows.map(toWorkspaceMembership)
  }

  async listRepos(
    accountId: string,
    after: DirectoryRepoKey | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryRepo[]> {
    const rows = await this.db
      .select(repoColumns)
      .from(githubRepos)
      .innerJoin(workspaces, eq(workspaces.id, githubRepos.workspace_id))
      .where(
        and(
          eq(workspaces.account_id, accountId),
          isNull(githubRepos.deleted_at),
          after === null
            ? undefined
            : or(
                gt(githubRepos.workspace_id, after.workspaceId),
                and(
                  eq(githubRepos.workspace_id, after.workspaceId),
                  gt(githubRepos.github_id, after.repoId),
                ),
              ),
          reach(githubRepos.workspace_id, workspaceIds),
        ),
      )
      .orderBy(asc(githubRepos.workspace_id), asc(githubRepos.github_id))
      .limit(limit)
    return rows.map(toRepo)
  }

  async getWorkspaces(accountId: string, ids: string[]): Promise<DirectoryWorkspace[]> {
    if (ids.length === 0) return []
    const rows = await this.db
      .select(workspaceColumns)
      .from(workspaces)
      .where(and(eq(workspaces.account_id, accountId), inArray(workspaces.id, ids)))
    return rows.map(toWorkspace)
  }

  async getUsers(accountId: string, ids: string[]): Promise<DirectoryUser[]> {
    if (ids.length === 0) return []
    return this.db
      .select(userColumns)
      .from(users)
      .innerJoin(memberships, eq(memberships.user_id, users.id))
      .where(and(eq(memberships.account_id, accountId), inArray(users.id, ids)))
  }

  async getAccountMemberships(
    accountId: string,
    userIds: string[],
  ): Promise<DirectoryAccountMembership[]> {
    if (userIds.length === 0) return []
    const rows = await this.db
      .select(accountMembershipColumns)
      .from(memberships)
      .where(and(eq(memberships.account_id, accountId), inArray(memberships.user_id, userIds)))
    return rows.map(toAccountMembership)
  }

  async getWorkspaceMemberships(
    accountId: string,
    keys: WorkspaceMembershipKey[],
  ): Promise<DirectoryWorkspaceMembership[]> {
    if (keys.length === 0) return []
    const rows = await this.db
      .select(workspaceMembershipColumns)
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspace_id))
      .where(
        and(
          eq(workspaces.account_id, accountId),
          or(
            ...keys.map((k) =>
              and(
                eq(workspaceMembers.workspace_id, k.workspaceId),
                eq(workspaceMembers.user_id, k.userId),
              ),
            ),
          ),
        ),
      )
    return rows.map(toWorkspaceMembership)
  }

  async getRepos(accountId: string, keys: DirectoryRepoKey[]): Promise<DirectoryRepo[]> {
    if (keys.length === 0) return []
    const rows = await this.db
      .select(repoColumns)
      .from(githubRepos)
      .innerJoin(workspaces, eq(workspaces.id, githubRepos.workspace_id))
      .where(
        and(
          eq(workspaces.account_id, accountId),
          isNull(githubRepos.deleted_at),
          or(
            ...keys.map((k) =>
              and(eq(githubRepos.workspace_id, k.workspaceId), eq(githubRepos.github_id, k.repoId)),
            ),
          ),
        ),
      )
    return rows.map(toRepo)
  }
}

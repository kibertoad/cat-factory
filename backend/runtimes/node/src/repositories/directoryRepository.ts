import {
  type AccountRole,
  type DirectoryAccountMembership,
  type DirectoryRepo,
  type DirectoryUser,
  type DirectoryWorkspace,
  type DirectoryWorkspaceMembership,
  isDirectoryEntityType,
} from '@cat-factory/contracts'
import type {
  DirectoryChangeRecord,
  DirectoryRepoKey,
  DirectoryRepository,
  WorkspaceMembershipKey,
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

// The directory read side over Postgres (docs/initiatives/directory-sync.md). Mirror of the
// Cloudflare facade's `D1DirectoryRepository`; `defineDirectoryFeedSuite` and
// `defineDirectoryReadSuite` hold the two to one behaviour. The feed rows themselves are appended
// by the writing repositories through `directoryFeed.ts`.

/** The entity types a key limited to some workspaces may read. */
const WORKSPACE_ENTITY_TYPES = ['workspace', 'workspace_membership', 'repo']

function rowToChange(row: typeof directoryChanges.$inferSelect): DirectoryChangeRecord {
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

function parseRoles(csv: string | null): AccountRole[] {
  const roles = (csv ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is AccountRole => r === 'admin' || r === 'developer' || r === 'product')
  return roles.length > 0 ? [...new Set(roles)] : ['developer']
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
          workspaceIds === null
            ? undefined
            : inArray(directoryChanges.entity_type, WORKSPACE_ENTITY_TYPES),
          reach(directoryChanges.workspace_id, workspaceIds),
        ),
      )
      .orderBy(asc(directoryChanges.seq))
      .limit(limit)
    return rows.map(rowToChange)
  }

  async headSeq(accountId: string): Promise<number> {
    const [row] = await this.db
      .select({ head: max(directoryChanges.seq) })
      .from(directoryChanges)
      .where(eq(directoryChanges.account_id, accountId))
    return row?.head ?? 0
  }

  async oldestSeq(accountId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ oldest: min(directoryChanges.seq) })
      .from(directoryChanges)
      .where(eq(directoryChanges.account_id, accountId))
    return row?.oldest ?? null
  }

  async pruneChanges(before: number): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM directory_changes
       WHERE at < ${before}
         AND seq < (SELECT MAX(d.seq) FROM directory_changes d
                     WHERE d.account_id = directory_changes.account_id)`)
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

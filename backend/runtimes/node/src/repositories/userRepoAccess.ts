import type { UserRepoAccessRecord, UserRepoAccessRepository } from '@cat-factory/kernel'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { githubUserRepoAccess } from '../db/schema.js'

// `excluded.<column>` reference for the conflict-update set (the just-attempted insert value).
const sqlExcluded = (column: string) => sql.raw(`excluded."${column}"`)

// Postgres-backed per-user "repos my PAT can reach" projection (mirror of D1 migration
// 0038 / D1UserRepoAccessRepository), keyed by (user_id, repo_github_id).

type Row = typeof githubUserRepoAccess.$inferSelect

const bool = (v: number): boolean => v === 1
const intBool = (v: boolean): number => (v ? 1 : 0)
const CHUNK = 50

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function toRecord(row: Row): UserRepoAccessRecord {
  return {
    userId: row.user_id,
    repoGithubId: row.repo_github_id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    private: bool(row.private),
    syncedAt: row.synced_at,
  }
}

function toValues(r: UserRepoAccessRecord) {
  return {
    user_id: r.userId,
    repo_github_id: r.repoGithubId,
    owner: r.owner,
    name: r.name,
    default_branch: r.defaultBranch,
    private: intBool(r.private),
    synced_at: r.syncedAt,
  }
}

// A chunked upsert over an insert-capable handle (the db or a transaction). A free function
// (not a method) so no extra symbol lands on the repository prototype (the mothership drift
// guard reflects every public method).
async function upsertBatches(
  runner: Pick<DrizzleDb, 'insert'>,
  repos: UserRepoAccessRecord[],
): Promise<void> {
  for (const batch of chunks(repos, CHUNK)) {
    await runner
      .insert(githubUserRepoAccess)
      .values(batch.map(toValues))
      .onConflictDoUpdate({
        target: [githubUserRepoAccess.user_id, githubUserRepoAccess.repo_github_id],
        set: {
          owner: sqlExcluded('owner'),
          name: sqlExcluded('name'),
          default_branch: sqlExcluded('default_branch'),
          private: sqlExcluded('private'),
          synced_at: sqlExcluded('synced_at'),
        },
      })
  }
}

export class DrizzleUserRepoAccessRepository implements UserRepoAccessRepository {
  constructor(private readonly db: DrizzleDb) {}

  async replaceForUser(userId: string, repos: UserRepoAccessRecord[]): Promise<void> {
    // A full re-enumeration: drop the stale set, then insert the current one, so a repo the
    // PAT can no longer reach stops granting visibility.
    await this.db.transaction(async (tx) => {
      await tx.delete(githubUserRepoAccess).where(eq(githubUserRepoAccess.user_id, userId))
      await upsertBatches(tx, repos)
    })
  }

  async recordAccessible(userId: string, repos: UserRepoAccessRecord[]): Promise<void> {
    if (repos.length === 0) return
    await upsertBatches(this.db, repos)
  }

  async listAccessibleRepoIds(userId: string, repoGithubIds: number[]): Promise<number[]> {
    if (repoGithubIds.length === 0) return []
    const found: number[] = []
    for (const batch of chunks(repoGithubIds, CHUNK)) {
      const rows = await this.db
        .select({ id: githubUserRepoAccess.repo_github_id })
        .from(githubUserRepoAccess)
        .where(
          and(
            eq(githubUserRepoAccess.user_id, userId),
            inArray(githubUserRepoAccess.repo_github_id, batch),
          ),
        )
      for (const row of rows) found.push(row.id)
    }
    return found
  }

  async listByUser(userId: string): Promise<UserRepoAccessRecord[]> {
    const rows = await this.db
      .select()
      .from(githubUserRepoAccess)
      .where(eq(githubUserRepoAccess.user_id, userId))
      .orderBy(asc(githubUserRepoAccess.owner), asc(githubUserRepoAccess.name))
    return rows.map(toRecord)
  }

  async removeForUser(userId: string): Promise<void> {
    await this.db.delete(githubUserRepoAccess).where(eq(githubUserRepoAccess.user_id, userId))
  }
}

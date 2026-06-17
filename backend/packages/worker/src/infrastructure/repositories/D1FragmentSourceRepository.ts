import type {
  FragmentOwnerKind,
  FragmentSourceRecord,
  FragmentSourceRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface FragmentSourceRow {
  id: string
  owner_kind: string
  owner_id: string
  repo_owner: string
  repo_name: string
  git_ref: string
  dir_path: string
  last_synced_sha: string | null
  last_synced_at: number | null
  created_at: number
  deleted_at: number | null
}

function rowToRecord(row: FragmentSourceRow): FragmentSourceRecord {
  return {
    id: row.id,
    ownerKind: row.owner_kind as FragmentOwnerKind,
    ownerId: row.owner_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    gitRef: row.git_ref,
    dirPath: row.dir_path,
    lastSyncedSha: row.last_synced_sha,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of fragment-source repo linkages (migration 0020). */
export class D1FragmentSourceRepository implements FragmentSourceRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByOwner(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
  ): Promise<FragmentSourceRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM fragment_sources WHERE owner_kind = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(ownerKind, ownerId)
      .all<FragmentSourceRow>()
    return results.map(rowToRecord)
  }

  async get(id: string): Promise<FragmentSourceRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM fragment_sources WHERE id = ?')
      .bind(id)
      .first<FragmentSourceRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: FragmentSourceRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO fragment_sources
          (id, owner_kind, owner_id, repo_owner, repo_name, git_ref, dir_path,
           last_synced_sha, last_synced_at, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           repo_owner = excluded.repo_owner,
           repo_name = excluded.repo_name,
           git_ref = excluded.git_ref,
           dir_path = excluded.dir_path,
           last_synced_sha = excluded.last_synced_sha,
           last_synced_at = excluded.last_synced_at,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        record.id,
        record.ownerKind,
        record.ownerId,
        record.repoOwner,
        record.repoName,
        record.gitRef,
        record.dirPath,
        record.lastSyncedSha,
        record.lastSyncedAt,
        record.createdAt,
        record.deletedAt,
      )
      .run()
  }

  async updateSyncState(id: string, lastSyncedSha: string, lastSyncedAt: number): Promise<void> {
    await this.db
      .prepare('UPDATE fragment_sources SET last_synced_sha = ?, last_synced_at = ? WHERE id = ?')
      .bind(lastSyncedSha, lastSyncedAt, id)
      .run()
  }

  async softDelete(id: string, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE fragment_sources SET deleted_at = ? WHERE id = ?')
      .bind(at, id)
      .run()
  }
}

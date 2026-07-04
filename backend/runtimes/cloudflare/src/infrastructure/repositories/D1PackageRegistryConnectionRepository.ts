import type {
  PackageRegistryConnectionRecord,
  PackageRegistryConnectionRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface PackageRegistryConnectionRow {
  workspace_id: string
  entries: string
  summary: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: PackageRegistryConnectionRow): PackageRegistryConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    entries: row.entries,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's private package-registry connection (migration 0034). Exactly one row
 * per workspace (the workspace id is the primary key). `entries` is a sealed envelope
 * of the registry-entry JSON array — the caller encrypts before upsert and decrypts at
 * dispatch time; `summary` is a non-secret display blob.
 */
export class D1PackageRegistryConnectionRepository implements PackageRegistryConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<PackageRegistryConnectionRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM package_registry_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<PackageRegistryConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: PackageRegistryConnectionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO package_registry_connections (workspace_id, entries, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           entries = excluded.entries,
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .bind(record.workspaceId, record.entries, record.summary, record.createdAt, record.updatedAt)
      .run()
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM package_registry_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .run()
  }
}

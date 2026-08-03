import type {
  CapabilityCredentialRecord,
  CapabilityCredentialRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface CapabilityCredentialRow {
  workspace_id: string
  credentials: string
  summary: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: CapabilityCredentialRow): CapabilityCredentialRecord {
  return {
    workspaceId: row.workspace_id,
    credentials: row.credentials,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's capability credentials (migration 0077). At most one row per workspace.
 * `credentials` is a sealed envelope of the `CapabilityCredentialEntry[]` JSON — the service
 * encrypts before upsert and decrypts at dispatch; `summary` is a non-secret
 * `CapabilityCredentialRef[]` display blob. The Drizzle mirror is
 * `DrizzleCapabilityCredentialRepository`.
 */
export class D1CapabilityCredentialRepository implements CapabilityCredentialRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<CapabilityCredentialRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM capability_credentials WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<CapabilityCredentialRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: CapabilityCredentialRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO capability_credentials (workspace_id, credentials, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           credentials = excluded.credentials,
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.credentials,
        record.summary,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM capability_credentials WHERE workspace_id = ?`)
      .bind(workspaceId)
      .run()
  }
}

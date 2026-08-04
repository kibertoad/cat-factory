import type {
  CapabilityCredentialRecord,
  CapabilityCredentialRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface CapabilityCredentialRow {
  workspace_id: string
  credentials: string
  summary: string
  rev: number
  created_at: number
  updated_at: number
}

function rowToRecord(row: CapabilityCredentialRow): CapabilityCredentialRecord {
  return {
    workspaceId: row.workspace_id,
    credentials: row.credentials,
    summary: row.summary,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's capability credentials (migration 0077, `rev` in 0078). At most one row per
 * workspace. `credentials` is a sealed envelope of the `CapabilityCredentialEntry[]` JSON — the
 * service encrypts before upsert and decrypts at dispatch; `summary` is a non-secret
 * `CapabilityCredentialRef[]` display blob. The per-key writes ride the rev-guarded
 * `compareAndSwap`/`deleteIfRev` (an `UPDATE/DELETE … WHERE rev = ?` whose changed-row count
 * decides the winner); the blind `upsert` bumps the stored rev in SQL so it stays monotonic. The
 * Drizzle mirror is `DrizzleCapabilityCredentialRepository`.
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
        `INSERT INTO capability_credentials (workspace_id, credentials, summary, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           credentials = excluded.credentials,
           summary = excluded.summary,
           rev = capability_credentials.rev + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.credentials,
        record.summary,
        record.rev,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async compareAndSwap(
    record: CapabilityCredentialRecord,
    expectedRev: number | null,
  ): Promise<boolean> {
    if (expectedRev === null) {
      const result = await this.db
        .prepare(
          `INSERT INTO capability_credentials (workspace_id, credentials, summary, rev, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id) DO NOTHING`,
        )
        .bind(
          record.workspaceId,
          record.credentials,
          record.summary,
          record.rev,
          record.createdAt,
          record.updatedAt,
        )
        .run()
      return (result.meta?.changes ?? 0) > 0
    }
    const result = await this.db
      .prepare(
        `UPDATE capability_credentials
           SET credentials = ?, summary = ?, rev = ?, updated_at = ?
         WHERE workspace_id = ? AND rev = ?`,
      )
      .bind(
        record.credentials,
        record.summary,
        record.rev,
        record.updatedAt,
        record.workspaceId,
        expectedRev,
      )
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async deleteIfRev(workspaceId: string, expectedRev: number): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM capability_credentials WHERE workspace_id = ? AND rev = ?`)
      .bind(workspaceId, expectedRev)
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM capability_credentials WHERE workspace_id = ?`)
      .bind(workspaceId)
      .run()
  }
}

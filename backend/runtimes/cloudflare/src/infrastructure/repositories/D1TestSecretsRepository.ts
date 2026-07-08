import type { TestSecretRecord, TestSecretsRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TestSecretRow {
  workspace_id: string
  block_id: string
  credentials: string
  summary: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: TestSecretRow): TestSecretRecord {
  return {
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    credentials: row.credentials,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A service frame's sensitive test credentials (migration 0044). At most one row per
 * (workspace, block). `credentials` is a sealed envelope of the `TestSecretEntry[]` JSON — the
 * service encrypts before upsert and decrypts at dispatch; `summary` is a non-secret
 * `TestSecretRef[]` display blob. The Drizzle mirror is `DrizzleTestSecretsRepository`.
 */
export class D1TestSecretsRepository implements TestSecretsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<TestSecretRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM test_secrets WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .first<TestSecretRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<TestSecretRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM test_secrets WHERE workspace_id = ?`)
      .bind(workspaceId)
      .all<TestSecretRow>()
    return (results ?? []).map(rowToRecord)
  }

  async upsert(record: TestSecretRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO test_secrets (workspace_id, block_id, credentials, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, block_id) DO UPDATE SET
           credentials = excluded.credentials,
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.blockId,
        record.credentials,
        record.summary,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM test_secrets WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .run()
  }
}

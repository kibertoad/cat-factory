import type { BinaryArtifactMetadataStore, BinaryArtifactRecord } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ArtifactRow {
  workspace_id: string
  id: string
  execution_id: string | null
  block_id: string | null
  kind: string
  view: string | null
  content_type: string
  byte_size: number
  hash: string
  storage: string
  storage_key: string
  created_at: number
}

function rowToRecord(row: ArtifactRow): BinaryArtifactRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    blockId: row.block_id,
    kind: row.kind as BinaryArtifactRecord['kind'],
    view: row.view,
    contentType: row.content_type,
    byteSize: row.byte_size,
    hash: row.hash,
    storage: row.storage as BinaryArtifactRecord['storage'],
    storageKey: row.storage_key,
    createdAt: row.created_at,
  }
}

/** D1-backed metadata store for binary artifacts (see migration 0017). Bytes live in R2/S3. */
export class D1BinaryArtifactMetadataStore implements BinaryArtifactMetadataStore {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async insert(record: BinaryArtifactRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO binary_artifacts
           (workspace_id, id, execution_id, block_id, kind, view, content_type,
            byte_size, hash, storage, storage_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.workspaceId,
        record.id,
        record.executionId,
        record.blockId,
        record.kind,
        record.view,
        record.contentType,
        record.byteSize,
        record.hash,
        record.storage,
        record.storageKey,
        record.createdAt,
      )
      .run()
  }

  async get(workspaceId: string, id: string): Promise<BinaryArtifactRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM binary_artifacts WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<ArtifactRow>()
    return row ? rowToRecord(row) : null
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<BinaryArtifactRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM binary_artifacts
         WHERE workspace_id = ? AND execution_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(workspaceId, executionId)
      .all<ArtifactRow>()
    return (results ?? []).map(rowToRecord)
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<BinaryArtifactRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM binary_artifacts
         WHERE workspace_id = ? AND block_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(workspaceId, blockId)
      .all<ArtifactRow>()
    return (results ?? []).map(rowToRecord)
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM binary_artifacts WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .run()
  }
}

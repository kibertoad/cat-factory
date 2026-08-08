import type {
  BinaryArtifactMetadataStore,
  BinaryArtifactRecord,
  DocumentArtifactRef,
  DocumentOrigin,
} from '@cat-factory/kernel'
import { dedupeDocumentRefs } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

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
  document_source: string | null
  document_external_id: string | null
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
    // Both halves or neither: a row with only one is not a document reference, and treating it as
    // one would key a reclaim on a half-identity that matches the wrong artifacts.
    document:
      row.document_source && row.document_external_id
        ? { source: row.document_source as DocumentOrigin, externalId: row.document_external_id }
        : null,
    createdAt: row.created_at,
  }
}

/**
 * Order rows the way every list read on this table returns them (`created_at`, then `id`), for a
 * batch read whose result is the concatenation of several statements.
 */
function sortArtifactRows(rows: ArtifactRow[]): ArtifactRow[] {
  return rows.sort(
    (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
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
            byte_size, hash, storage, storage_key, document_source, document_external_id,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.document?.source ?? null,
        record.document?.externalId ?? null,
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

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM binary_artifacts WHERE workspace_id = ? AND execution_id = ?',
      )
      .bind(workspaceId, executionId)
      .first<{ n: number }>()
    return row?.n ?? 0
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

  async listByDocument(
    workspaceId: string,
    document: DocumentArtifactRef,
  ): Promise<BinaryArtifactRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM binary_artifacts
         WHERE workspace_id = ? AND document_source = ? AND document_external_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(workspaceId, document.source, document.externalId)
      .all<ArtifactRow>()
    return (results ?? []).map(rowToRecord)
  }

  async listByDocuments(
    workspaceId: string,
    documents: readonly DocumentArtifactRef[],
  ): Promise<BinaryArtifactRecord[]> {
    const refs = dedupeDocumentRefs(documents)
    if (!refs.length) return []
    const rows: ArtifactRow[] = []
    // Two bound params per ref (source + external id), so the chunk size is derived from that
    // rather than from the scalar-`IN` default.
    for (const chunk of chunkForIn(refs, 2)) {
      const clauses = chunk
        .map(() => '(document_source = ? AND document_external_id = ?)')
        .join(' OR ')
      const { results } = await this.db
        .prepare(`SELECT * FROM binary_artifacts WHERE workspace_id = ? AND (${clauses})`)
        .bind(workspaceId, ...chunk.flatMap((ref) => [ref.source, ref.externalId]))
        .all<ArtifactRow>()
      rows.push(...(results ?? []))
    }
    // Sorted here rather than per statement: with more than one chunk the concatenation is
    // ordered by chunk, and the caller's "newest render for a view wins" rule reads the WHOLE
    // list in order.
    return sortArtifactRows(rows).map(rowToRecord)
  }

  async deleteByIds(workspaceId: string, ids: readonly string[]): Promise<number> {
    let removed = 0
    for (const chunk of chunkForIn(ids)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { meta } = await this.db
        .prepare(
          `DELETE FROM binary_artifacts
           WHERE workspace_id = ? AND id IN (${placeholders})`,
        )
        .bind(workspaceId, ...chunk)
        .run()
      removed += meta.changes ?? 0
    }
    return removed
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM binary_artifacts WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .run()
  }

  // The age sweep's two halves carry the SAME `document_source IS NULL` exemption: a document's
  // renders expire with their document, never on a clock (see the port).
  async listOlderThan(workspaceId: string, olderThan: number): Promise<BinaryArtifactRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM binary_artifacts
         WHERE workspace_id = ? AND created_at < ? AND document_source IS NULL`,
      )
      .bind(workspaceId, olderThan)
      .all<ArtifactRow>()
    return (results ?? []).map(rowToRecord)
  }

  async deleteOlderThan(workspaceId: string, olderThan: number): Promise<number> {
    const { meta } = await this.db
      .prepare(
        `DELETE FROM binary_artifacts
         WHERE workspace_id = ? AND created_at < ? AND document_source IS NULL`,
      )
      .bind(workspaceId, olderThan)
      .run()
    return meta.changes ?? 0
  }

  async listByWorkspace(workspaceId: string): Promise<BinaryArtifactRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM binary_artifacts WHERE workspace_id = ?')
      .bind(workspaceId)
      .all<ArtifactRow>()
    return (results ?? []).map(rowToRecord)
  }

  async deleteByWorkspace(workspaceId: string): Promise<number> {
    const { meta } = await this.db
      .prepare('DELETE FROM binary_artifacts WHERE workspace_id = ?')
      .bind(workspaceId)
      .run()
    return meta.changes ?? 0
  }
}

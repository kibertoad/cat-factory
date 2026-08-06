import type {
  DocKind,
  DocumentLinkRole,
  DocumentOrigin,
  DocumentRecord,
  DocumentRef,
  DocumentRepository,
} from '@cat-factory/kernel'
import { urlMatchCandidates } from '@cat-factory/kernel'
import { chunkForIn } from './chunk'
import type { D1Database } from '@cloudflare/workers-types'

interface DocumentRow {
  workspace_id: string
  source: string
  external_id: string
  title: string
  url: string
  excerpt: string
  body: string
  content_hash: string | null
  source_version: string | null
  linked_block_id: string | null
  role: string | null
  doc_kind: string | null
  synced_at: number
  deleted_at: number | null
}

/**
 * Group a ref list by origin so each origin becomes ONE chunked `IN` read/write rather than a
 * statement per ref. A task attaches documents from at most a handful of origins, so this is a
 * small, bounded number of statements. Mirrors `D1TaskRepository.listByRefs`.
 */
function groupRefsByOrigin(refs: readonly DocumentRef[]): Map<DocumentOrigin, string[]> {
  const byOrigin = new Map<DocumentOrigin, string[]>()
  for (const ref of refs) {
    const ids = byOrigin.get(ref.source)
    if (ids) ids.push(ref.externalId)
    else byOrigin.set(ref.source, [ref.externalId])
  }
  return byOrigin
}

function rowToRecord(row: DocumentRow): DocumentRecord {
  return {
    workspaceId: row.workspace_id,
    source: row.source as DocumentOrigin,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    excerpt: row.excerpt,
    body: row.body,
    contentHash: row.content_hash ?? '',
    sourceVersion: row.source_version,
    linkedBlockId: row.linked_block_id,
    role: (row.role as DocumentLinkRole | null) ?? null,
    docKind: (row.doc_kind as DocKind | null) ?? null,
    syncedAt: row.synced_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of imported document projections, across sources (migration 0012). */
export class D1DocumentRepository implements DocumentRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsert(record: DocumentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO documents
          (workspace_id, source, external_id, title, url, excerpt, body,
           content_hash, source_version, linked_block_id, synced_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (workspace_id, source, external_id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           excerpt = excluded.excerpt,
           body = excluded.body,
           content_hash = excluded.content_hash,
           source_version = excluded.source_version,
           linked_block_id = excluded.linked_block_id,
           synced_at = excluded.synced_at,
           deleted_at = NULL`,
      )
      .bind(
        record.workspaceId,
        record.source,
        record.externalId,
        record.title,
        record.url,
        record.excerpt,
        record.body,
        record.contentHash,
        record.sourceVersion,
        record.linkedBlockId,
        record.syncedAt,
      )
      .run()
  }

  async get(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
  ): Promise<DocumentRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND source = ? AND external_id = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, source, externalId)
      .first<DocumentRow>()
    return row ? rowToRecord(row) : null
  }

  async listByRefs(workspaceId: string, refs: readonly DocumentRef[]): Promise<DocumentRecord[]> {
    if (refs.length === 0) return []
    const out: DocumentRecord[] = []
    for (const [source, externalIds] of groupRefsByOrigin(refs)) {
      // Chunk the IN list to stay under D1's bound-parameter limit (the two leading params
      // — workspace_id + source — are within chunkForIn's headroom).
      for (const chunk of chunkForIn(externalIds)) {
        const placeholders = chunk.map(() => '?').join(', ')
        const { results } = await this.db
          .prepare(
            `SELECT * FROM documents WHERE workspace_id = ? AND source = ? AND external_id IN (${placeholders}) AND deleted_at IS NULL`,
          )
          .bind(workspaceId, source, ...chunk)
          .all<DocumentRow>()
        for (const row of results ?? []) out.push(rowToRecord(row))
      }
    }
    return out
  }

  async listByWorkspace(workspaceId: string): Promise<DocumentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId)
      .all<DocumentRow>()
    return results.map(rowToRecord)
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<DocumentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND linked_block_id = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId, blockId)
      .all<DocumentRow>()
    return results.map(rowToRecord)
  }

  async getByUrl(workspaceId: string, url: string): Promise<DocumentRecord | null> {
    // A needle that normalises to nothing is not a URL, and must never be matched (see
    // `urlMatchCandidates`).
    const candidates = urlMatchCandidates(url)
    if (!candidates) return null
    const [a, b] = candidates
    const row = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND url IN (?, ?) AND deleted_at IS NULL ORDER BY synced_at DESC LIMIT 1',
      )
      .bind(workspaceId, a, b)
      .first<DocumentRow>()
    return row ? rowToRecord(row) : null
  }

  async linkBlock(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
    blockId: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE documents SET linked_block_id = ? WHERE workspace_id = ? AND source = ? AND external_id = ?',
      )
      .bind(blockId, workspaceId, source, externalId)
      .run()
  }

  async detachBlocks(workspaceId: string, blockIds: readonly string[]): Promise<void> {
    if (blockIds.length === 0) return
    for (const chunk of chunkForIn([...blockIds])) {
      const placeholders = chunk.map(() => '?').join(', ')
      await this.db
        .prepare(
          `UPDATE documents SET linked_block_id = NULL WHERE workspace_id = ? AND linked_block_id IN (${placeholders})`,
        )
        .bind(workspaceId, ...chunk)
        .run()
    }
  }

  async linkBlockMany(
    workspaceId: string,
    refs: readonly DocumentRef[],
    blockId: string | null,
  ): Promise<void> {
    if (refs.length === 0) return
    // One statement per origin-chunk, submitted as a D1 BATCH: a task's documents attach
    // together or not at all, so a failure part-way cannot leave the block holding a subset of
    // the corpus it was created with (the exact half-attached state the public-API creation
    // refuses to return). `db.batch` is D1's transaction — it is the Postgres `transaction`
    // block's counterpart in the Drizzle mirror.
    const statements = []
    for (const [source, externalIds] of groupRefsByOrigin(refs)) {
      for (const chunk of chunkForIn(externalIds)) {
        const placeholders = chunk.map(() => '?').join(', ')
        statements.push(
          this.db
            .prepare(
              `UPDATE documents SET linked_block_id = ? WHERE workspace_id = ? AND source = ? AND external_id IN (${placeholders})`,
            )
            .bind(blockId, workspaceId, source, ...chunk),
        )
      }
    }
    await this.db.batch(statements)
  }

  async getRoleLink(
    workspaceId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<DocumentRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND role = ? AND doc_kind = ? AND deleted_at IS NULL ORDER BY synced_at DESC LIMIT 1',
      )
      .bind(workspaceId, role, docKind)
      .first<DocumentRow>()
    return row ? rowToRecord(row) : null
  }

  async listRoleLinks(
    workspaceId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<DocumentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND role = ? AND doc_kind = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId, role, docKind)
      .all<DocumentRow>()
    return results.map(rowToRecord)
  }

  async listRoleLinksByWorkspace(workspaceId: string): Promise<DocumentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND role IS NOT NULL AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId)
      .all<DocumentRow>()
    return results.map(rowToRecord)
  }

  async setRole(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE documents SET role = ?, doc_kind = ? WHERE workspace_id = ? AND source = ? AND external_id = ?',
      )
      .bind(role, docKind, workspaceId, source, externalId)
      .run()
  }

  async clearRole(workspaceId: string, source: DocumentOrigin, externalId: string): Promise<void> {
    await this.db
      .prepare(
        'UPDATE documents SET role = NULL, doc_kind = NULL WHERE workspace_id = ? AND source = ? AND external_id = ?',
      )
      .bind(workspaceId, source, externalId)
      .run()
  }

  async clearRoleForKind(
    workspaceId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE documents SET role = NULL, doc_kind = NULL WHERE workspace_id = ? AND role = ? AND doc_kind = ?',
      )
      .bind(workspaceId, role, docKind)
      .run()
  }
}

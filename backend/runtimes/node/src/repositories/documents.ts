import type {
  DocKind,
  DocumentConnectionRepository,
  DocumentLinkRole,
  DocumentOrigin,
  DocumentRecord,
  DocumentRef,
  DocumentRepository,
  DocumentSourceKind,
  SealedDocumentConnectionRecord,
} from '@cat-factory/kernel'
import { urlMatchCandidates } from '@cat-factory/kernel'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { documentConnections, documents } from '../db/schema.js'

// Drizzle/Postgres mirrors of the document-source D1 repositories (migration 0012).
// A `source` discriminator tags every row, so one pair of tables serves every
// provider. Behaviourally identical to the D1 repos so the cross-runtime conformance
// suite asserts the same document behaviour against both stores.

type DocumentConnectionRow = typeof documentConnections.$inferSelect

/**
 * Workspace → document-source connections over Postgres. Source credentials cross this repository
 * as the AES-256-GCM ENVELOPE they are stored as: the seal is the row's value, not an encoding
 * this class hides. Opening one belongs to `createDocumentConnectionStore`
 * (`@cat-factory/integrations`), which is what lets a deployment holding no key for these rows — a
 * mothership-mode node — still read them, by naming the row over `/internal/secrets/unseal`.
 */
export class DrizzleDocumentConnectionRepository implements DocumentConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  private rowToRecord(row: DocumentConnectionRow): SealedDocumentConnectionRecord {
    return {
      workspaceId: row.workspace_id,
      source: row.source as DocumentSourceKind,
      credentialsCipher: row.credentials,
      label: row.label,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }
  }

  async getByWorkspace(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<SealedDocumentConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(documentConnections)
      .where(
        and(
          eq(documentConnections.workspace_id, workspaceId),
          eq(documentConnections.source, source),
          isNull(documentConnections.deleted_at),
        ),
      )
      .limit(1)
    return rows[0] ? this.rowToRecord(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<SealedDocumentConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(documentConnections)
      .where(
        and(
          eq(documentConnections.workspace_id, workspaceId),
          isNull(documentConnections.deleted_at),
        ),
      )
      .orderBy(desc(documentConnections.created_at))
    return rows.map((row) => this.rowToRecord(row))
  }

  async upsert(record: SealedDocumentConnectionRecord): Promise<void> {
    // A workspace has a single live connection per source: clear any prior binding
    // (live or tombstoned) before inserting, so reconnecting can't collide on the
    // (workspace_id, source) primary key. Delete + insert run in one transaction so a
    // concurrent reader never sees the connection transiently absent.
    await this.db.transaction(async (tx) => {
      await tx
        .delete(documentConnections)
        .where(
          and(
            eq(documentConnections.workspace_id, record.workspaceId),
            eq(documentConnections.source, record.source),
          ),
        )
      await tx.insert(documentConnections).values({
        workspace_id: record.workspaceId,
        source: record.source,
        credentials: record.credentialsCipher,
        label: record.label,
        created_at: record.createdAt,
        deleted_at: null,
      })
    })
  }

  async softDelete(workspaceId: string, source: DocumentSourceKind, at: number): Promise<void> {
    await this.db
      .update(documentConnections)
      .set({ deleted_at: at })
      .where(
        and(
          eq(documentConnections.workspace_id, workspaceId),
          eq(documentConnections.source, source),
          isNull(documentConnections.deleted_at),
        ),
      )
  }
}

type DocumentRow = typeof documents.$inferSelect

/**
 * Group a ref list by origin so each origin becomes ONE `IN` read/write rather than a statement
 * per ref. A task attaches documents from at most a handful of origins, so this is a small,
 * bounded number of statements. (Postgres has no D1-style bound-parameter ceiling, so the id
 * lists need no chunking — mirroring `getByUrl` and `DrizzleTaskRepository.listByRefs`.)
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

function rowToDocument(row: DocumentRow): DocumentRecord {
  return {
    workspaceId: row.workspace_id,
    source: row.source as DocumentOrigin,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    excerpt: row.excerpt,
    body: row.body,
    contentHash: row.content_hash,
    sourceVersion: row.source_version,
    linkedBlockId: row.linked_block_id,
    role: (row.role as DocumentLinkRole | null) ?? null,
    docKind: (row.doc_kind as DocKind | null) ?? null,
    syncedAt: row.synced_at,
    deletedAt: row.deleted_at,
  }
}

/** Imported document projections over Postgres, across sources (migration 0012). */
export class DrizzleDocumentRepository implements DocumentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsert(record: DocumentRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      source: record.source,
      external_id: record.externalId,
      title: record.title,
      url: record.url,
      excerpt: record.excerpt,
      body: record.body,
      content_hash: record.contentHash,
      source_version: record.sourceVersion,
      linked_block_id: record.linkedBlockId,
      synced_at: record.syncedAt,
      deleted_at: null,
    }
    await this.db
      .insert(documents)
      .values(values)
      .onConflictDoUpdate({
        target: [documents.workspace_id, documents.source, documents.external_id],
        set: {
          title: values.title,
          url: values.url,
          excerpt: values.excerpt,
          body: values.body,
          content_hash: values.content_hash,
          source_version: values.source_version,
          linked_block_id: values.linked_block_id,
          synced_at: values.synced_at,
          deleted_at: null,
        },
      })
  }

  async get(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
  ): Promise<DocumentRecord | null> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          eq(documents.source, source),
          eq(documents.external_id, externalId),
          isNull(documents.deleted_at),
        ),
      )
      .limit(1)
    return rows[0] ? rowToDocument(rows[0]) : null
  }

  async listByRefs(workspaceId: string, refs: readonly DocumentRef[]): Promise<DocumentRecord[]> {
    if (refs.length === 0) return []
    const out: DocumentRecord[] = []
    for (const [source, externalIds] of groupRefsByOrigin(refs)) {
      const rows = await this.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.workspace_id, workspaceId),
            eq(documents.source, source),
            inArray(documents.external_id, externalIds),
            isNull(documents.deleted_at),
          ),
        )
      for (const row of rows) out.push(rowToDocument(row))
    }
    return out
  }

  async listByWorkspace(workspaceId: string): Promise<DocumentRecord[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.workspace_id, workspaceId), isNull(documents.deleted_at)))
      .orderBy(desc(documents.synced_at))
    return rows.map(rowToDocument)
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<DocumentRecord[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          eq(documents.linked_block_id, blockId),
          isNull(documents.deleted_at),
        ),
      )
      .orderBy(desc(documents.synced_at))
    return rows.map(rowToDocument)
  }

  async getByUrl(workspaceId: string, url: string): Promise<DocumentRecord | null> {
    // A needle that normalises to nothing is not a URL, and must never be matched (see
    // `urlMatchCandidates`).
    const candidates = urlMatchCandidates(url)
    if (!candidates) return null
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          inArray(documents.url, candidates),
          isNull(documents.deleted_at),
        ),
      )
      .orderBy(desc(documents.synced_at))
      .limit(1)
    return rows[0] ? rowToDocument(rows[0]) : null
  }

  async linkBlock(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
    blockId: string | null,
  ): Promise<void> {
    await this.db
      .update(documents)
      .set({ linked_block_id: blockId })
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          eq(documents.source, source),
          eq(documents.external_id, externalId),
        ),
      )
  }

  async detachBlocks(workspaceId: string, blockIds: readonly string[]): Promise<void> {
    if (blockIds.length === 0) return
    await this.db
      .update(documents)
      .set({ linked_block_id: null })
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          inArray(documents.linked_block_id, [...blockIds]),
        ),
      )
  }

  async linkBlockMany(
    workspaceId: string,
    refs: readonly DocumentRef[],
    blockId: string | null,
  ): Promise<void> {
    if (refs.length === 0) return
    // One statement per origin, in a transaction: a task's documents attach together or not at
    // all, so a failure part-way cannot leave the block holding a subset of the corpus it was
    // created with (the exact half-attached state the public-API creation refuses to return).
    await this.db.transaction(async (tx) => {
      for (const [source, externalIds] of groupRefsByOrigin(refs)) {
        await tx
          .update(documents)
          .set({ linked_block_id: blockId })
          .where(
            and(
              eq(documents.workspace_id, workspaceId),
              eq(documents.source, source),
              inArray(documents.external_id, externalIds),
            ),
          )
      }
    })
  }

  async getRoleLink(
    workspaceId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<DocumentRecord | null> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          eq(documents.role, role),
          eq(documents.doc_kind, docKind),
          isNull(documents.deleted_at),
        ),
      )
      .orderBy(desc(documents.synced_at))
      .limit(1)
    return rows[0] ? rowToDocument(rows[0]) : null
  }

  async listRoleLinks(
    workspaceId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<DocumentRecord[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          eq(documents.role, role),
          eq(documents.doc_kind, docKind),
          isNull(documents.deleted_at),
        ),
      )
      .orderBy(desc(documents.synced_at))
    return rows.map(rowToDocument)
  }

  async listRoleLinksByWorkspace(workspaceId: string): Promise<DocumentRecord[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          isNotNull(documents.role),
          isNull(documents.deleted_at),
        ),
      )
      .orderBy(desc(documents.synced_at))
    return rows.map(rowToDocument)
  }

  async setRole(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<void> {
    await this.db
      .update(documents)
      .set({ role, doc_kind: docKind })
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          eq(documents.source, source),
          eq(documents.external_id, externalId),
        ),
      )
  }

  async clearRole(workspaceId: string, source: DocumentOrigin, externalId: string): Promise<void> {
    await this.db
      .update(documents)
      .set({ role: null, doc_kind: null })
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          eq(documents.source, source),
          eq(documents.external_id, externalId),
        ),
      )
  }

  async clearRoleForKind(
    workspaceId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<void> {
    await this.db
      .update(documents)
      .set({ role: null, doc_kind: null })
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          eq(documents.role, role),
          eq(documents.doc_kind, docKind),
        ),
      )
  }
}

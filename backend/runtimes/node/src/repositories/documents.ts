import type {
  DocKind,
  DocumentConnectionRecord,
  DocumentConnectionRepository,
  DocumentLinkRole,
  DocumentRecord,
  DocumentRepository,
  DocumentSourceKind,
  SecretCipher,
} from '@cat-factory/kernel'
import { urlMatchCandidates } from '@cat-factory/kernel'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { documentConnections, documents } from '../db/schema.js'

// Drizzle/Postgres mirrors of the document-source D1 repositories (migration 0012).
// A `source` discriminator tags every row, so one pair of tables serves every
// provider. Behaviourally identical to the D1 repos so the cross-runtime conformance
// suite asserts the same document behaviour against both stores.

function parseCredentials(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
  } catch {
    // A malformed bag is treated as empty; the import path then fails closed.
  }
  return {}
}

type DocumentConnectionRow = typeof documentConnections.$inferSelect

/**
 * Workspace → document-source connections over Postgres. Source credentials (a
 * third-party API token) are encrypted at rest with the same AES-256-GCM envelope
 * cipher the environments/Slack integrations use — never stored plaintext. A legacy
 * row whose `credentials` predates encryption (no `v1.` envelope) is read as
 * plaintext JSON, then re-encrypted on the next write.
 */
export class DrizzleDocumentConnectionRepository implements DocumentConnectionRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly cipher: SecretCipher,
  ) {}

  private async decodeCredentials(stored: string): Promise<Record<string, string>> {
    if (!stored.startsWith('v1.')) return parseCredentials(stored)
    try {
      return parseCredentials(await this.cipher.decrypt(stored))
    } catch {
      // Wrong key / corrupt envelope: fail closed with an empty bag.
      return {}
    }
  }

  private async rowToRecord(row: DocumentConnectionRow): Promise<DocumentConnectionRecord> {
    return {
      workspaceId: row.workspace_id,
      source: row.source as DocumentSourceKind,
      credentials: await this.decodeCredentials(row.credentials),
      label: row.label,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }
  }

  async getByWorkspace(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord | null> {
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

  async listByWorkspace(workspaceId: string): Promise<DocumentConnectionRecord[]> {
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
    return Promise.all(rows.map((row) => this.rowToRecord(row)))
  }

  async upsert(record: DocumentConnectionRecord): Promise<void> {
    const credentials = await this.cipher.encrypt(JSON.stringify(record.credentials))
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
        credentials,
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

function rowToDocument(row: DocumentRow): DocumentRecord {
  return {
    workspaceId: row.workspace_id,
    source: row.source as DocumentSourceKind,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    excerpt: row.excerpt,
    body: row.body,
    contentHash: row.content_hash,
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
          linked_block_id: values.linked_block_id,
          synced_at: values.synced_at,
          deleted_at: null,
        },
      })
  }

  async get(
    workspaceId: string,
    source: DocumentSourceKind,
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
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspace_id, workspaceId),
          inArray(documents.url, urlMatchCandidates(url)),
          isNull(documents.deleted_at),
        ),
      )
      .orderBy(desc(documents.synced_at))
      .limit(1)
    return rows[0] ? rowToDocument(rows[0]) : null
  }

  async linkBlock(
    workspaceId: string,
    source: DocumentSourceKind,
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
    source: DocumentSourceKind,
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

  async clearRole(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<void> {
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

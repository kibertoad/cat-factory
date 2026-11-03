// Drizzle/Postgres metadata store for binary artifacts, the twin of the D1
// `D1BinaryArtifactMetadataStore`. Its rows live in the telemetry schema beside the other
// run-observability sinks; the BYTES live in the account's blob backend.

import type {
  BinaryArtifactMetadataStore,
  BinaryArtifactRecord,
  DocumentArtifactRef,
  DocumentOrigin,
} from '@cat-factory/kernel'
import {
  BLOCK_ANCHORED_BINARY_ARTIFACT_KINDS,
  RETAINED_BINARY_ARTIFACT_KINDS,
  dedupeDocumentRefs,
} from '@cat-factory/kernel'
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, notInArray, or } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { binaryArtifacts } from '../../db/schema.js'

function rowToBinaryArtifact(row: typeof binaryArtifacts.$inferSelect): BinaryArtifactRecord {
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

/** Drizzle/Postgres metadata store for binary artifacts (mirror of D1 migration 0017). */

export class DrizzleBinaryArtifactMetadataStore implements BinaryArtifactMetadataStore {
  constructor(private readonly db: DrizzleDb) {}

  async insert(record: BinaryArtifactRecord): Promise<void> {
    await this.db.insert(binaryArtifacts).values({
      workspace_id: record.workspaceId,
      id: record.id,
      execution_id: record.executionId,
      block_id: record.blockId,
      kind: record.kind,
      view: record.view,
      content_type: record.contentType,
      byte_size: record.byteSize,
      hash: record.hash,
      storage: record.storage,
      storage_key: record.storageKey,
      document_source: record.document?.source ?? null,
      document_external_id: record.document?.externalId ?? null,
      created_at: record.createdAt,
    })
  }

  async get(workspaceId: string, id: string): Promise<BinaryArtifactRecord | null> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.id, id)))
      .limit(1)
    return rows[0] ? rowToBinaryArtifact(rows[0]) : null
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(
        and(
          eq(binaryArtifacts.workspace_id, workspaceId),
          eq(binaryArtifacts.execution_id, executionId),
        ),
      )
      .orderBy(asc(binaryArtifacts.created_at), asc(binaryArtifacts.id))
    return rows.map(rowToBinaryArtifact)
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(binaryArtifacts)
      .where(
        and(
          eq(binaryArtifacts.workspace_id, workspaceId),
          eq(binaryArtifacts.execution_id, executionId),
        ),
      )
    return rows[0]?.n ?? 0
  }

  async countByBlock(workspaceId: string, blockId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(binaryArtifacts)
      .where(
        and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.block_id, blockId)),
      )
    return rows[0]?.n ?? 0
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(
        and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.block_id, blockId)),
      )
      .orderBy(asc(binaryArtifacts.created_at), asc(binaryArtifacts.id))
    return rows.map(rowToBinaryArtifact)
  }

  async listByBlocks(
    workspaceId: string,
    blockIds: readonly string[],
  ): Promise<BinaryArtifactRecord[]> {
    const ids = [...new Set(blockIds)]
    const rows: (typeof binaryArtifacts.$inferSelect)[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const found = await this.db
        .select()
        .from(binaryArtifacts)
        .where(
          and(
            eq(binaryArtifacts.workspace_id, workspaceId),
            inArray(binaryArtifacts.block_id, ids.slice(i, i + 500)),
          ),
        )
      rows.push(...found)
    }
    return rows
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(rowToBinaryArtifact)
  }

  async moveBlocks(
    workspaceIds: readonly [from: string, to: string],
    blockIds: readonly string[],
  ): Promise<number> {
    const [from, to] = workspaceIds
    const ids = [...new Set(blockIds)]
    let moved = 0
    for (let i = 0; i < ids.length; i += 500) {
      const updated = await this.db
        .update(binaryArtifacts)
        .set({ workspace_id: to })
        .where(
          and(
            eq(binaryArtifacts.workspace_id, from),
            inArray(binaryArtifacts.block_id, ids.slice(i, i + 500)),
          ),
        )
        .returning({ id: binaryArtifacts.id })
      moved += updated.length
    }
    return moved
  }

  async listBlockAnchorsOlderThan(workspaceId: string, olderThan: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ blockId: binaryArtifacts.block_id })
      .from(binaryArtifacts)
      .where(
        and(
          eq(binaryArtifacts.workspace_id, workspaceId),
          lt(binaryArtifacts.created_at, olderThan),
          isNotNull(binaryArtifacts.block_id),
          inArray(binaryArtifacts.kind, BLOCK_ANCHORED_BINARY_ARTIFACT_KINDS as string[]),
        ),
      )
    return rows.flatMap((row) => (row.blockId ? [row.blockId] : []))
  }

  async listByDocument(
    workspaceId: string,
    document: DocumentArtifactRef,
  ): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(this.documentScope(workspaceId, document))
      .orderBy(asc(binaryArtifacts.created_at), asc(binaryArtifacts.id))
    return rows.map(rowToBinaryArtifact)
  }

  async listByDocuments(
    workspaceId: string,
    documents: readonly DocumentArtifactRef[],
  ): Promise<BinaryArtifactRecord[]> {
    const refs = dedupeDocumentRefs(documents)
    if (!refs.length) return []
    const rows: (typeof binaryArtifacts.$inferSelect)[] = []
    for (let i = 0; i < refs.length; i += 500) {
      const chunk = refs.slice(i, i + 500)
      const found = await this.db
        .select()
        .from(binaryArtifacts)
        .where(
          and(
            eq(binaryArtifacts.workspace_id, workspaceId),
            or(
              ...chunk.map((ref) =>
                and(
                  eq(binaryArtifacts.document_source, ref.source),
                  eq(binaryArtifacts.document_external_id, ref.externalId),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(binaryArtifacts.created_at), asc(binaryArtifacts.id))
      rows.push(...found)
    }
    // Re-sorted across chunks: each statement orders its own rows, and the caller's "newest
    // render for a view wins" rule reads the whole list in order.
    return rows
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(rowToBinaryArtifact)
  }

  async deleteByIds(workspaceId: string, ids: readonly string[]): Promise<number> {
    let removed = 0
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      const deleted = await this.db
        .delete(binaryArtifacts)
        .where(
          and(
            eq(binaryArtifacts.workspace_id, workspaceId),
            inArray(binaryArtifacts.id, ids.slice(i, i + 500) as string[]),
          ),
        )
        .returning({ id: binaryArtifacts.id })
      removed += deleted.length
    }
    return removed
  }

  private documentScope(workspaceId: string, document: DocumentArtifactRef) {
    return and(
      eq(binaryArtifacts.workspace_id, workspaceId),
      eq(binaryArtifacts.document_source, document.source),
      eq(binaryArtifacts.document_external_id, document.externalId),
    )
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(binaryArtifacts)
      .where(and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.id, id)))
  }

  async listOlderThan(workspaceId: string, olderThan: number): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(this.agedScope(workspaceId, olderThan))
    return rows.map(rowToBinaryArtifact)
  }

  async deleteOlderThan(workspaceId: string, olderThan: number): Promise<number> {
    const deleted = await this.db
      .delete(binaryArtifacts)
      .where(this.agedScope(workspaceId, olderThan))
      .returning({ id: binaryArtifacts.id })
    return deleted.length
  }

  /**
   * The age sweep's scope, shared by its list and its delete so the two cannot drift: run debris
   * past the window, EXCLUDING a document's renders, which expire with their document rather than
   * on a clock, and every kind the port marks as retained (see the port).
   */
  private agedScope(workspaceId: string, olderThan: number) {
    return and(
      eq(binaryArtifacts.workspace_id, workspaceId),
      lt(binaryArtifacts.created_at, olderThan),
      isNull(binaryArtifacts.document_source),
      notInArray(binaryArtifacts.kind, RETAINED_BINARY_ARTIFACT_KINDS as string[]),
    )
  }

  async listByWorkspace(workspaceId: string): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(eq(binaryArtifacts.workspace_id, workspaceId))
    return rows.map(rowToBinaryArtifact)
  }

  async deleteByWorkspace(workspaceId: string): Promise<number> {
    const deleted = await this.db
      .delete(binaryArtifacts)
      .where(eq(binaryArtifacts.workspace_id, workspaceId))
      .returning({ id: binaryArtifacts.id })
    return deleted.length
  }
}

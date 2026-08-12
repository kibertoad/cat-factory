import { bigint, customType, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// The BINARY-artifact tables: the queryable metadata mirror of the D1 table, plus the
// Node-ONLY store-in-DB blob backend and the `bytea` column type only that backend uses.
//
// One cohesive group, split out of `../schema.ts` so that module stays inside its
// (shrink-only) size budget. `../schema.ts` re-exports both tables, so every existing
// `from '../db/schema.js'` import is unaffected and drizzle-kit still sees them through
// that entry point.
// ---------------------------------------------------------------------------

// Raw binary column (Postgres `bytea`), used by the Node-only `binary_artifact_blobs`
// store-in-DB blob backend. Reads/writes as a `Uint8Array`.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value)
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value)
  },
})

// Binary-artifact METADATA (mirror of D1 migration 0017). The bytes live in a blob
// backend keyed by `storage_key` (R2 / S3 / the `binary_artifact_blobs` table below);
// this table holds only the queryable metadata, identical column-for-column to D1.
export const binaryArtifacts = pgTable(
  'binary_artifacts',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    execution_id: text('execution_id'),
    block_id: text('block_id'),
    kind: text('kind').notNull(),
    view: text('view'),
    content_type: text('content_type').notNull(),
    byte_size: integer('byte_size').notNull(),
    hash: text('hash').notNull(),
    storage: text('storage').notNull(),
    storage_key: text('storage_key').notNull(),
    // The imported document this artifact was rendered FROM (mirror of D1 migration 0087), or NULL
    // for one a person uploaded. The document's own source identity rather than the block it is
    // attached to: an import runs before any attachment exists, and only document-sourced artifacts
    // are replaced wholesale on a re-import.
    document_source: text('document_source'),
    document_external_id: text('document_external_id'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_binary_artifacts_execution').on(t.workspace_id, t.execution_id),
    index('idx_binary_artifacts_block').on(t.workspace_id, t.block_id),
    // The re-import reclaim deletes every artifact rendered from one document, so it is an indexed
    // range delete rather than a per-workspace scan.
    index('idx_binary_artifacts_document').on(
      t.workspace_id,
      t.document_source,
      t.document_external_id,
    ),
    // The per-workspace retention sweep filters on `created_at`; index it so the prune is an
    // indexed range delete (mirrors the D1 idx_binary_artifacts_created index).
    index('idx_binary_artifacts_created').on(t.workspace_id, t.created_at),
  ],
)

// Node-ONLY blob backend: when an account selects the `db` content-storage backend, the
// bytes live in this Postgres `bytea` table (keyed by the artifact's `storage_key`). There
// is no D1 equivalent — on Cloudflare blobs always go to R2 (D1 can't hold large values), so
// this store-in-DB backend genuinely cannot exist on the Worker runtime.
export const binaryArtifactBlobs = pgTable('binary_artifact_blobs', {
  storage_key: text('storage_key').primaryKey(),
  bytes: bytea('bytes').notNull(),
})

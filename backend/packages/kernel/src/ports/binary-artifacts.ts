import type { Clock, IdGenerator } from './runtime.js'

// ---------------------------------------------------------------------------
// Binary-artifact storage: a runtime-neutral abstraction for storing opaque
// binary blobs (today: UI screenshots + the reference design images they are
// reviewed against) with queryable metadata. Unlike every other domain record,
// a blob can be large (a full-page PNG), so the bytes and the metadata are
// stored separately: the METADATA always lives in the runtime's relational
// store (D1 on Cloudflare, Postgres on Node — so it can be listed/joined/pruned
// like any other row), while the BYTES live in whatever blob backend the
// deployment configured (R2 on Cloudflare, S3 via @cat-factory/provider-s3, or
// a Postgres `bytea` table on Node/local; or anything custom).
//
// The seam is split so a deployment mixes-and-matches without duplicating the
// metadata SQL per backend:
//   - {@link BinaryArtifactMetadataStore} — per-runtime metadata persistence.
//   - {@link BinaryBlobBackend} — the pluggable "custom adapter": put/get/delete
//     bytes by key. R2 / S3 / Postgres-bytea / in-memory all implement it.
//   - {@link createBinaryArtifactStore} — composes the two into the
//     {@link BinaryArtifactStore} the rest of the app depends on.
// ---------------------------------------------------------------------------

/** Where a blob's bytes physically live. The metadata always lives in the DB. */
export type BinaryArtifactStorageKind = 'db' | 'r2' | 's3' | 'memory'

/** What an artifact is — drives actual-vs-reference pairing in the gate UI. */
export type BinaryArtifactKind = 'screenshot' | 'reference'

/** Metadata describing one stored blob (the bytes live in a {@link BinaryBlobBackend}). */
export interface BinaryArtifactRecord {
  id: string
  workspaceId: string
  /** The run this artifact belongs to (null for workspace-scoped uploads). */
  executionId: string | null
  /** The board block (task) this artifact belongs to (null when unscoped). */
  blockId: string | null
  kind: BinaryArtifactKind
  /** Logical view name, used to pair a captured screenshot with its reference. */
  view: string | null
  /** MIME type, e.g. `image/png`. */
  contentType: string
  byteSize: number
  /** Content hash (sha-256 hex) — drives non-redundant capture / dedup. */
  hash: string
  /** Which backend holds the bytes. */
  storage: BinaryArtifactStorageKind
  /** Backend-specific locator for the bytes (e.g. the R2/S3 object key). */
  storageKey: string
  createdAt: number
}

/** The fields a caller supplies; the store derives the rest (id/hash/size/…). */
export interface StoreBinaryArtifactInput {
  meta: Pick<
    BinaryArtifactRecord,
    'workspaceId' | 'executionId' | 'blockId' | 'kind' | 'view' | 'contentType'
  >
  blob: Uint8Array
}

/**
 * The port the rest of the app depends on: store a blob + metadata in one call,
 * read either back, list a run's artifacts, delete one. Composed from a metadata
 * store + a blob backend by {@link createBinaryArtifactStore}.
 */
export interface BinaryArtifactStore {
  store(input: StoreBinaryArtifactInput): Promise<BinaryArtifactRecord>
  getMetadata(workspaceId: string, id: string): Promise<BinaryArtifactRecord | null>
  getBlob(workspaceId: string, id: string): Promise<Uint8Array | null>
  listByExecution(workspaceId: string, executionId: string): Promise<BinaryArtifactRecord[]>
  delete(workspaceId: string, id: string): Promise<void>
}

/** Per-runtime metadata persistence (D1 ⇄ Drizzle). Bytes live elsewhere. */
export interface BinaryArtifactMetadataStore {
  insert(record: BinaryArtifactRecord): Promise<void>
  get(workspaceId: string, id: string): Promise<BinaryArtifactRecord | null>
  listByExecution(workspaceId: string, executionId: string): Promise<BinaryArtifactRecord[]>
  delete(workspaceId: string, id: string): Promise<void>
}

/**
 * The pluggable blob backend — the "custom adapter interface". Implement this to
 * store bytes anywhere: R2 (Cloudflare), S3 (@cat-factory/provider-s3), a
 * Postgres `bytea` table (Node), an in-memory map (tests), or your own store.
 * `kind` is stamped onto the metadata `storage` column so a read knows where the
 * bytes live.
 */
export interface BinaryBlobBackend {
  readonly kind: BinaryArtifactStorageKind
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

// Web Crypto is a global in both workerd and Node, but the kernel compiles against the
// ES2022 lib only (no DOM/WebWorker), so reach it through `globalThis` with a minimal
// local type instead of pulling in the DOM lib.
interface MinimalSubtleCrypto {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
}
const webCryptoSubtle = (globalThis as { crypto?: { subtle?: MinimalSubtleCrypto } }).crypto?.subtle

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** sha-256 hex over the bytes (Web Crypto — present in workerd + Node). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!webCryptoSubtle) {
    // No Web Crypto (should not happen on a real runtime): fall back to a cheap,
    // non-cryptographic FNV-1a so dedup still works deterministically.
    let h = 0x811c9dc5
    for (const b of bytes) {
      h ^= b
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const digest = await webCryptoSubtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

/**
 * Compose a {@link BinaryArtifactStore} from a metadata store + a blob backend.
 * The store derives the id, content hash, byte size, storage tag and key; writes
 * the bytes first (so a metadata row never points at missing bytes) then the
 * metadata row. Deleting removes the bytes best-effort then the metadata.
 */
export function createBinaryArtifactStore(deps: {
  metadata: BinaryArtifactMetadataStore
  blob: BinaryBlobBackend
  idGenerator: IdGenerator
  clock: Clock
}): BinaryArtifactStore {
  const { metadata, blob, idGenerator, clock } = deps
  return {
    async store(input) {
      const id = idGenerator.next('art')
      const bytes = input.blob
      const hash = await sha256Hex(bytes)
      const storageKey = `${input.meta.workspaceId}/${id}`
      await blob.put(storageKey, bytes, input.meta.contentType)
      const record: BinaryArtifactRecord = {
        id,
        workspaceId: input.meta.workspaceId,
        executionId: input.meta.executionId,
        blockId: input.meta.blockId,
        kind: input.meta.kind,
        view: input.meta.view,
        contentType: input.meta.contentType,
        byteSize: bytes.byteLength,
        hash,
        storage: blob.kind,
        storageKey,
        createdAt: clock.now(),
      }
      await metadata.insert(record)
      return record
    },
    getMetadata(workspaceId, id) {
      return metadata.get(workspaceId, id)
    },
    async getBlob(workspaceId, id) {
      const record = await metadata.get(workspaceId, id)
      if (!record) return null
      return blob.get(record.storageKey)
    },
    listByExecution(workspaceId, executionId) {
      return metadata.listByExecution(workspaceId, executionId)
    },
    async delete(workspaceId, id) {
      const record = await metadata.get(workspaceId, id)
      if (record) await blob.delete(record.storageKey)
      await metadata.delete(workspaceId, id)
    },
  }
}

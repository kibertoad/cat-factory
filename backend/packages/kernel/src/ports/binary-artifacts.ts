import type { DocumentOrigin } from '../domain/types.js'
import type { Clock, IdGenerator } from './runtime.js'
import type { Logger } from './logging.js'

// ---------------------------------------------------------------------------
// Binary-artifact storage: a runtime-neutral abstraction for storing opaque
// binary blobs (today: UI screenshots + the reference design images they are
// reviewed against) with queryable metadata. Unlike every other domain record,
// a blob can be large (a full-page PNG), so the bytes and the metadata are
// stored separately: the METADATA always lives in the runtime's relational
// store (D1 on Cloudflare, Postgres on Node — so it can be listed/joined/pruned
// like any other row), while the BYTES live in whatever blob backend the
// account configured (R2 on Cloudflare; S3 via @cat-factory/provider-s3, a
// Postgres `bytea` table or the local filesystem on Node/local; or anything
// custom). The backend is chosen per-account in the UI, not at boot.
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
export type BinaryArtifactStorageKind = 'db' | 'r2' | 's3' | 'fs' | 'memory'

/** What an artifact is — drives actual-vs-reference pairing in the gate UI. */
export type BinaryArtifactKind = 'screenshot' | 'reference'

/**
 * The document an artifact was rendered FROM, when it came from one.
 *
 * A reference image has two possible provenances that must not be confused: a person uploaded it
 * against a task, or an import downloaded it from a design source. Only the second can be
 * REPLACED wholesale on a re-import, so it carries the document's own SOURCE identity — never the
 * linked block (a document is imported before it is attached to anything, and one document can be
 * attached to a different block later) and never anything it displays.
 */
export interface DocumentArtifactRef {
  source: DocumentOrigin
  externalId: string
}

/**
 * Collapse a document list to the distinct `(source, externalId)` pairs a batch read should ask
 * about. Shared by both metadata stores so a duplicate ref cannot cost one runtime a repeated OR
 * clause (and duplicate rows in its result) while the other happens to dedupe.
 */
export function dedupeDocumentRefs(
  documents: readonly DocumentArtifactRef[],
): DocumentArtifactRef[] {
  const seen = new Map<string, DocumentArtifactRef>()
  for (const document of documents) {
    const key = `${document.source}::${document.externalId}`
    if (!seen.has(key)) seen.set(key, document)
  }
  return [...seen.values()]
}

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
  /**
   * The imported document this artifact was rendered from, or null for one a person uploaded.
   * See {@link DocumentArtifactRef}.
   */
  document: DocumentArtifactRef | null
  createdAt: number
}

/** The fields a caller supplies; the store derives the rest (id/hash/size/…). */
export interface StoreBinaryArtifactInput {
  meta: Pick<
    BinaryArtifactRecord,
    'workspaceId' | 'executionId' | 'blockId' | 'kind' | 'view' | 'contentType'
  > &
    Partial<Pick<BinaryArtifactRecord, 'document'>>
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
  /**
   * Read a blob's metadata AND bytes in one call (a single metadata lookup), for the
   * serve path that needs both the content type (from metadata) and the bytes. Returns
   * null when the metadata row is missing; `{ record, bytes: null }` when the row exists
   * but its bytes are gone from the backend.
   */
  getBlobWithMetadata(
    workspaceId: string,
    id: string,
  ): Promise<{ record: BinaryArtifactRecord; bytes: Uint8Array | null } | null>
  listByExecution(workspaceId: string, executionId: string): Promise<BinaryArtifactRecord[]>
  /** How many artifacts a run has (the per-run upload cap precheck — indexed COUNT, no row materialise). */
  countByExecution(workspaceId: string, executionId: string): Promise<number>
  /**
   * Artifacts attached to a board block (task), across runs — used by the
   * visual-confirmation gate to read the human-uploaded reference design images, which
   * are attached to the block before any run (so they carry no executionId).
   */
  listByBlock(workspaceId: string, blockId: string): Promise<BinaryArtifactRecord[]>
  /**
   * Artifacts rendered from one imported document — the design renders an import retained, read
   * back by the surfaces that pair them with a task's screenshots.
   */
  listByDocument(
    workspaceId: string,
    document: DocumentArtifactRef,
  ): Promise<BinaryArtifactRecord[]>
  /**
   * The same renders for a LIST of documents, in one batched read: what a reader with a task's
   * whole set of linked designs in hand calls, rather than {@link listByDocument} per document.
   *
   * The visual-confirmation gate is that reader, and it runs on the driver path of every run whose
   * pipeline carries the gate, so a point read per attached design is exactly the N+1 the batch
   * ports exist to prevent. Each record still names its own `document`, so a caller that needs the
   * per-document split indexes the result rather than asking again.
   */
  listByDocuments(
    workspaceId: string,
    documents: readonly DocumentArtifactRef[],
  ): Promise<BinaryArtifactRecord[]>
  delete(workspaceId: string, id: string): Promise<void>
  /**
   * Re-import reclaim: delete every artifact rendered from one document — BOTH the metadata rows
   * AND their bytes — and return how many were removed.
   *
   * Called BEFORE an import stores the new renders, not after, so the document's images are never
   * a mix of two revisions. The cost of that ordering is a window in which a design carries no
   * images at all, which is the honest failure: an import that then cannot download will record
   * `failed` beside an empty set, where the reverse ordering would leave last month's frames
   * looking like this month's. Same fail-safe blobs-first reclaim as {@link pruneOlderThan}.
   */
  pruneByDocument(workspaceId: string, document: DocumentArtifactRef): Promise<number>
  /**
   * Retention sweep: delete every artifact in the workspace created before `olderThan`
   * (epoch ms) — BOTH the metadata row AND its bytes — and return how many were removed.
   * Drives the configurable per-workspace retention cleanup (default 14 days).
   *
   * EXEMPTS artifacts carrying a {@link DocumentArtifactRef}. Age is the right lifetime for run
   * debris, which is produced once and never referenced again, and the wrong one for a document's
   * renders, which are a PROJECTION of a live row: they are replaced wholesale by the next import
   * that changes the body ({@link pruneByDocument}) and by nothing else. Sweeping them on a clock
   * would leave `documents.render_status` saying `stored` over an empty set, and nothing would
   * re-download them, because an unedited design is never re-imported. Their reclaim is the
   * document's own, not the calendar's.
   */
  pruneOlderThan(workspaceId: string, olderThan: number): Promise<number>
  /**
   * Board-delete reclaim: delete EVERY artifact in the workspace — BOTH the metadata rows
   * AND their bytes — and return how many were removed. Called from the workspace-delete
   * path (the retention sweeps only ever see LIVE workspaces via `listVisible`, so a deleted
   * workspace's artifacts would otherwise leak the heavy blob bytes forever). Same fail-safe
   * blobs-first ordering as {@link pruneOlderThan}: a blob whose delete throws keeps its
   * metadata row (the only handle on the key) rather than orphaning the bytes.
   *
   * NOTE the asymmetry with {@link pruneOlderThan}'s retry story: the retention sweep revisits
   * a LIVE workspace hourly, so a row it retains is genuinely retried; but a DELETED workspace
   * never reappears in `listVisible`, so a row retained here is NOT auto-retried — it needs an
   * out-of-band reclaim. The composed store therefore logs (via its injected logger) whenever a
   * blob delete fails so the residual leak is surfaced rather than silent.
   */
  deleteByWorkspace(workspaceId: string): Promise<number>
}

/** Per-runtime metadata persistence (D1 ⇄ Drizzle). Bytes live elsewhere. */
export interface BinaryArtifactMetadataStore {
  insert(record: BinaryArtifactRecord): Promise<void>
  get(workspaceId: string, id: string): Promise<BinaryArtifactRecord | null>
  listByExecution(workspaceId: string, executionId: string): Promise<BinaryArtifactRecord[]>
  /** Count a run's artifacts without materialising rows (the per-run upload cap precheck). */
  countByExecution(workspaceId: string, executionId: string): Promise<number>
  listByBlock(workspaceId: string, blockId: string): Promise<BinaryArtifactRecord[]>
  /** Records rendered from one imported document (the design renders an import retained). */
  listByDocument(
    workspaceId: string,
    document: DocumentArtifactRef,
  ): Promise<BinaryArtifactRecord[]>
  /**
   * The same records for a LIST of documents, in ONE chunked statement per call rather than a
   * read per document. Empty input reads nothing; a document naming no row is simply absent.
   * Ordered like the single-document read (`createdAt`, then `id`) across the whole result, so
   * "the newest render for a view wins" holds the same way however many documents were asked for.
   */
  listByDocuments(
    workspaceId: string,
    documents: readonly DocumentArtifactRef[],
  ): Promise<BinaryArtifactRecord[]>
  /**
   * Delete exactly the named metadata rows in ONE chunked statement; returns how many went.
   *
   * Every id-scoped reclaim goes through this rather than a predicate, because a predicate
   * re-evaluates at DELETE time against rows the caller never listed and therefore never
   * reclaimed the bytes of. The document reclaim is where that bites: two imports of one document
   * race routinely (a manual re-import beside a dispatch-time refresh), and a `WHERE
   * document_source = …` delete would drop the row the other import had just inserted, orphaning
   * its blob with nothing left pointing at the key. Ids name the rows whose bytes are already
   * gone, so the statement can only ever remove those.
   *
   * Empty input is a no-op. Ids naming no row are silently skipped, so a reclaim stays idempotent.
   */
  deleteByIds(workspaceId: string, ids: readonly string[]): Promise<number>
  delete(workspaceId: string, id: string): Promise<void>
  /**
   * Records in the workspace created before `olderThan` (epoch ms) — for the retention sweep.
   * EXCLUDES document-keyed renders, whose lifetime is their document's; see
   * {@link BinaryArtifactStore.pruneOlderThan} for why age is the wrong clock for those.
   */
  listOlderThan(workspaceId: string, olderThan: number): Promise<BinaryArtifactRecord[]>
  /**
   * Delete metadata rows in the workspace created before `olderThan`; returns the count. Carries
   * the SAME document-keyed exemption as {@link listOlderThan}: the two predicates are one rule,
   * and a delete wider than its list would reclaim rows whose bytes nothing had removed.
   */
  deleteOlderThan(workspaceId: string, olderThan: number): Promise<number>
  /** Every record in the workspace — for the workspace-delete purge. */
  listByWorkspace(workspaceId: string): Promise<BinaryArtifactRecord[]>
  /** Delete every metadata row in the workspace; returns the count. */
  deleteByWorkspace(workspaceId: string): Promise<number>
}

/**
 * The pluggable blob backend — the "custom adapter interface". Implement this to
 * store bytes anywhere: R2 (Cloudflare), S3 (@cat-factory/provider-s3), a
 * Postgres `bytea` table or the local filesystem (Node/local), an in-memory map
 * (tests), or your own store.
 * `kind` is stamped onto the metadata `storage` column so a read knows where the
 * bytes live.
 */
export interface BinaryBlobBackend {
  readonly kind: BinaryArtifactStorageKind
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

/**
 * Resolve the {@link BinaryArtifactStore} for a workspace's owning ACCOUNT. The blob
 * backend (filesystem / S3 / R2 / Postgres) is configured per-account in the UI, so the
 * store is resolved at request/run time from the account's settings rather than wired once
 * at boot. Returns `null` when the account has no storage configured (or selected `off`),
 * which every consumer treats as "storage unavailable" — the artifact controllers 503 and
 * the visual-confirmation gate passes through. The facade composes this from the account
 * settings + a runtime-specific blob-backend factory + the runtime's metadata store.
 */
export type ResolveBinaryArtifactStore = (
  workspaceId: string,
) => Promise<BinaryArtifactStore | null>

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
  /**
   * Optional structural logger for best-effort diagnostics. Used only to SURFACE a partial
   * reclaim (one or more blob deletes failed, so their metadata rows are retained) — otherwise
   * that residual leak would be silent. See {@link BinaryArtifactStore.deleteByWorkspace} for
   * why the workspace-delete path in particular has no auto-retry to fall back on.
   */
  logger?: Logger
}): BinaryArtifactStore {
  const { metadata, blob, idGenerator, clock, logger } = deps
  // Shared fail-safe reclaim for a batch of records (drives both `pruneOlderThan` and
  // `deleteByWorkspace`). Delete the BYTES first (best-effort per blob, so one stuck object
  // doesn't strand the rest), then drop the metadata rows. The invariant in both directions:
  // NEVER drop a metadata row whose blob is still present-but-failed-to-delete, because that
  // would orphan the bytes forever (the metadata is the only handle on the key). So a blob
  // delete that throws keeps its metadata row, leaving the pair intact — and the common
  // all-succeeded path still collapses to a single bulk delete. We also never keep a metadata
  // row pointing at already-deleted bytes.
  //
  // Whether the retained pair is genuinely retried depends on the caller: `pruneOlderThan` runs
  // against a LIVE workspace the sweep revisits hourly (real retry), but `deleteByWorkspace`'s
  // workspace never reappears in `listVisible` (no auto-retry — an out-of-band reclaim is
  // needed). Either way a non-empty failure set is a leak worth surfacing, so we log it here
  // rather than swallowing it silently at every call site.
  async function reclaim(
    records: BinaryArtifactRecord[],
    bulkDelete: () => Promise<number>,
  ): Promise<number> {
    const failed = new Set<string>()
    for (const record of records) {
      try {
        await blob.delete(record.storageKey)
      } catch {
        // Tolerate a backend hiccup on a single object; retain its metadata so a later reclaim
        // retries the blob delete instead of orphaning the bytes.
        failed.add(record.id)
      }
    }
    // Fast path: every blob went, so a single range delete reclaims all the metadata.
    if (failed.size === 0) return bulkDelete()
    logger?.warn(
      'binary-artifact reclaim: some blob deletes failed; their metadata rows are retained (bytes not yet reclaimed)',
      { workspaceId: records[0]?.workspaceId, failed: failed.size, total: records.length },
    )
    // Otherwise delete only the rows whose bytes are confirmed gone, leaving the failed pairs
    // (row + blob) intact for a later reclaim. One chunked id-scoped statement rather than a
    // delete per record: the survivor set is a list already in hand, and a point delete per row
    // is the N+1 this port's batch method exists to prevent.
    const survivors = records.filter((record) => !failed.has(record.id))
    if (!survivors.length) return 0
    return metadata.deleteByIds(
      survivors[0]!.workspaceId,
      survivors.map((record) => record.id),
    )
  }
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
        // Defaulted here rather than required of every caller: an artifact a person uploaded has
        // no document behind it, and that is the majority case.
        document: input.meta.document ?? null,
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
    async getBlobWithMetadata(workspaceId, id) {
      const record = await metadata.get(workspaceId, id)
      if (!record) return null
      return { record, bytes: await blob.get(record.storageKey) }
    },
    listByExecution(workspaceId, executionId) {
      return metadata.listByExecution(workspaceId, executionId)
    },
    countByExecution(workspaceId, executionId) {
      return metadata.countByExecution(workspaceId, executionId)
    },
    listByBlock(workspaceId, blockId) {
      return metadata.listByBlock(workspaceId, blockId)
    },
    listByDocument(workspaceId, document) {
      return metadata.listByDocument(workspaceId, document)
    },
    listByDocuments(workspaceId, documents) {
      return metadata.listByDocuments(workspaceId, documents)
    },
    async pruneByDocument(workspaceId, document) {
      const previous = await metadata.listByDocument(workspaceId, document)
      if (!previous.length) return 0
      // The bulk delete is scoped to the ids just listed, NOT to the document predicate. A
      // re-import stores the replacement renders moments after this returns, and a second import
      // racing the first would have its fresh rows swept by a predicate delete that never
      // reclaimed their bytes. See `deleteByIds`.
      return reclaim(previous, () =>
        metadata.deleteByIds(
          workspaceId,
          previous.map((record) => record.id),
        ),
      )
    },
    async delete(workspaceId, id) {
      const record = await metadata.get(workspaceId, id)
      if (record) await blob.delete(record.storageKey)
      await metadata.delete(workspaceId, id)
    },
    async pruneOlderThan(workspaceId, olderThan) {
      const expired = await metadata.listOlderThan(workspaceId, olderThan)
      return reclaim(expired, () => metadata.deleteOlderThan(workspaceId, olderThan))
    },
    async deleteByWorkspace(workspaceId) {
      const all = await metadata.listByWorkspace(workspaceId)
      return reclaim(all, () => metadata.deleteByWorkspace(workspaceId))
    },
  }
}

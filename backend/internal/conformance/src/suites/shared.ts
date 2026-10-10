import type {
  BinaryArtifactRecord,
  BinaryArtifactStore,
  Initiative,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import { expect } from 'vitest'
import type { ConformanceApp } from '../harness.js'

/**
 * Mint a public-API key through the SESSION surface and return its bearer header.
 *
 * Here rather than copied into each `integration-public-*.ts` suite, which is where it lived five
 * times over: every public-API suite starts by minting a key, so the day the mint route changes
 * shape (a required field, a different response envelope) it is one edit and not five, and a
 * missed one fails a whole facade's suite at setup with no clue why.
 *
 * The label carries the caller's own `purpose` so a leaked key row in a failing run still says
 * which suite made it.
 */
export async function mintPublicApiKey(
  app: ConformanceApp,
  workspaceId: string,
  scope: 'read' | 'write' | 'decide' | 'admin',
  purpose: string,
): Promise<Record<string, string>> {
  const created = await app.call<{ key: { id: string }; secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: `conformance-${purpose}-${scope}`, scope },
  )
  expect(created.status).toBe(201)
  return { authorization: `Bearer ${created.body.secret}` }
}

// Binary-storage start-gate helpers (see the `visual-confirmation` / UI-tester tests).
// The Worker test env binds R2 (storage ON by default) while Node/local default to OFF and
// the two share no configurable backend, so the suite injects the resolver directly to drive
// the gate identically on every runtime: a non-null store ⇒ a storage-reliant pipeline starts,
// a null-returning resolver ⇒ it is refused with `binary_storage_unconfigured`.
const EMPTY_BINARY_ARTIFACT_STORE: BinaryArtifactStore = {
  store: () => Promise.reject(new Error('not used in conformance')),
  getMetadata: () => Promise.resolve(null),
  getBlob: () => Promise.resolve(null),
  getBlobWithMetadata: () => Promise.resolve(null),
  listByExecution: () => Promise.resolve([]),
  countByExecution: () => Promise.resolve(0),
  listByBlock: () => Promise.resolve([]),
  countByBlock: () => Promise.resolve(0),
  listByDocument: () => Promise.resolve([]),
  listByDocuments: () => Promise.resolve([]),
  pruneByDocument: () => Promise.resolve(0),
  delete: () => Promise.resolve(),
  pruneOlderThan: () => Promise.resolve(0),
  deleteByWorkspace: () => Promise.resolve(0),
}
/** Storage configured: every workspace resolves the (empty) store, so the gate is satisfied. */
export const STORAGE_ON: ResolveBinaryArtifactStore = () =>
  Promise.resolve(EMPTY_BINARY_ARTIFACT_STORE)

/**
 * A binary-artifact store that actually HOLDS what is put in it, for the suites that read
 * artifacts back rather than merely proving the start gate was satisfied (the public evidence
 * surface lists a run's artifacts and streams their bytes).
 *
 * Every read filters by `workspaceId`, exactly as both real stores do: that scoping is the
 * boundary the public blob endpoint relies on, so a fake that ignored it would let a
 * cross-workspace assertion pass on a bug.
 */
export function memoryBinaryArtifactStore(): BinaryArtifactStore & {
  seed(record: BinaryArtifactRecord, bytes: Uint8Array): void
} {
  const rows = new Map<string, { record: BinaryArtifactRecord; bytes: Uint8Array }>()
  const owned = (workspaceId: string, id: string) => {
    const held = rows.get(id)
    return held && held.record.workspaceId === workspaceId ? held : null
  }
  /** Drop every row matching `match` (bytes and metadata together), returning how many went. */
  const reclaim = (match: (record: BinaryArtifactRecord) => boolean) => {
    const doomed = [...rows.values()].filter((held) => match(held.record))
    for (const held of doomed) rows.delete(held.record.id)
    return doomed.length
  }
  return {
    seed(record, bytes) {
      rows.set(record.id, { record, bytes })
    },
    store: () => Promise.reject(new Error('seed() directly in conformance')),
    getMetadata: (workspaceId, id) => Promise.resolve(owned(workspaceId, id)?.record ?? null),
    getBlob: (workspaceId, id) => Promise.resolve(owned(workspaceId, id)?.bytes ?? null),
    getBlobWithMetadata: (workspaceId, id) => {
      const held = owned(workspaceId, id)
      return Promise.resolve(held ? { record: held.record, bytes: held.bytes } : null)
    },
    listByExecution: (workspaceId, executionId) =>
      Promise.resolve(
        [...rows.values()]
          .filter(
            (r) => r.record.workspaceId === workspaceId && r.record.executionId === executionId,
          )
          .map((r) => r.record),
      ),
    countByExecution: (workspaceId, executionId) =>
      Promise.resolve(
        [...rows.values()].filter(
          (r) => r.record.workspaceId === workspaceId && r.record.executionId === executionId,
        ).length,
      ),
    listByBlock: (workspaceId, blockId) =>
      Promise.resolve(
        [...rows.values()]
          .filter((r) => r.record.workspaceId === workspaceId && r.record.blockId === blockId)
          .map((r) => r.record),
      ),
    countByBlock: (workspaceId, blockId) =>
      Promise.resolve(
        [...rows.values()].filter(
          (r) => r.record.workspaceId === workspaceId && r.record.blockId === blockId,
        ).length,
      ),
    listByDocument: (workspaceId, document) =>
      Promise.resolve(
        [...rows.values()]
          .filter(
            (r) =>
              r.record.workspaceId === workspaceId &&
              r.record.document?.source === document.source &&
              r.record.document.externalId === document.externalId,
          )
          .map((r) => r.record),
      ),
    listByDocuments: (workspaceId, documents) =>
      Promise.resolve(
        [...rows.values()]
          .filter((r) =>
            documents.some(
              (document) =>
                r.record.workspaceId === workspaceId &&
                r.record.document?.source === document.source &&
                r.record.document.externalId === document.externalId,
            ),
          )
          .map((r) => r.record),
      ),
    // The reclaims REMOVE, rather than answering 0 and keeping the rows. A double whose reads are
    // real and whose deletes are not is worse than an unimplemented one: a suite asserting that a
    // re-import REPLACES a document's renders would see both revisions accumulate and still pass,
    // which is exactly the bug such a suite is written to catch.
    pruneByDocument: (workspaceId, document) =>
      Promise.resolve(
        reclaim(
          (record) =>
            record.workspaceId === workspaceId &&
            record.document?.source === document.source &&
            record.document.externalId === document.externalId,
        ),
      ),
    delete: (workspaceId, id) => {
      if (owned(workspaceId, id)) rows.delete(id)
      return Promise.resolve()
    },
    // Carries the port's document-keyed exemption: a design's renders expire with their document,
    // never on the retention clock.
    pruneOlderThan: (workspaceId, olderThan) =>
      Promise.resolve(
        reclaim(
          (record) =>
            record.workspaceId === workspaceId && record.createdAt < olderThan && !record.document,
        ),
      ),
    deleteByWorkspace: (workspaceId) =>
      Promise.resolve(reclaim((record) => record.workspaceId === workspaceId)),
  }
}
/** Storage off: the account has no content storage, so the start gate must refuse the run. */
export const STORAGE_OFF: ResolveBinaryArtifactStore = () => Promise.resolve(null)

/**
 * A minimal `executing` initiative entity created from the `preset_spawned_conf` preset, anchored to
 * `anchorBlockId`. Seeded directly so the spawned-run preset-context assertion (D1) can link a task
 * to it via `block.initiativeId` without driving a whole planning loop.
 */
export function spawnedInitiative(anchorBlockId: string): Initiative {
  return {
    id: `initv-${anchorBlockId}`,
    blockId: anchorBlockId,
    slug: 'connector-factory',
    title: 'Connector factory',
    presetId: 'preset_spawned_conf',
    goal: '',
    constraints: [],
    nonGoals: [],
    qa: [],
    analysisSummary: '',
    phases: [],
    items: [],
    policy: null,
    decisions: [],
    deviations: [],
    followUps: [],
    caveats: [],
    status: 'executing',
    rev: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

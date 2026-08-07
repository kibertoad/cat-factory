import type {
  BinaryArtifactRecord,
  BinaryArtifactStore,
  Initiative,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'

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
  listByDocument: () => Promise.resolve([]),
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
    pruneByDocument: () => Promise.resolve(0),
    delete: (workspaceId, id) => {
      if (owned(workspaceId, id)) rows.delete(id)
      return Promise.resolve()
    },
    pruneOlderThan: () => Promise.resolve(0),
    deleteByWorkspace: () => Promise.resolve(0),
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

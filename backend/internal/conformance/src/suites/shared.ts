import type {
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
  delete: () => Promise.resolve(),
  pruneOlderThan: () => Promise.resolve(0),
  deleteByWorkspace: () => Promise.resolve(0),
}
/** Storage configured: every workspace resolves the (empty) store, so the gate is satisfied. */
export const STORAGE_ON: ResolveBinaryArtifactStore = () =>
  Promise.resolve(EMPTY_BINARY_ARTIFACT_STORE)
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

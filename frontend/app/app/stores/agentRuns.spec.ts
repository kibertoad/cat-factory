import { describe, it, expect, beforeEach } from 'vitest'
import type { BootstrapJob, EnvConfigRepairJob } from '~/types/domain'
import { useAgentRunsStore } from '~/stores/agentRuns'

/** Minimal BootstrapJob factory — only the fields the store's reconcile logic touches. */
function job(id: string, over: Partial<BootstrapJob> = {}): BootstrapJob {
  return {
    id,
    workspaceId: 'ws_test',
    referenceArchitectureId: null,
    referenceArchitectureName: null,
    repoName: id,
    repoOwner: null,
    repoUrl: null,
    instructions: '',
    status: 'running',
    blockId: `blk_${id}`,
    subtasks: null,
    error: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('agentRuns store — monotonic bootstrap reconcile', () => {
  let store: ReturnType<typeof useAgentRunsStore>
  beforeEach(() => {
    store = useAgentRunsStore()
  })

  it('hydrate does NOT regress a run a newer live event already advanced', () => {
    // A live `bootstrap: failed` event landed first (newer updatedAt).
    store.upsertBootstrap(job('j1', { status: 'failed', updatedAt: 5 }))
    // A lagging `workspace.refresh()` then hydrates a STALE snapshot that still saw
    // the run as `running` (older updatedAt) — it must NOT clobber the terminal state.
    store.hydrate([job('j1', { status: 'running', updatedAt: 2 })], 'ws_test')
    expect(store.bootstrapJobs[0]!.status).toBe('failed')
    expect(store.byBlock.blk_j1!.status).toBe('failed')
  })

  it('hydrate does NOT drop a live-added run the stale snapshot never saw', () => {
    // The on-connect resync fires a snapshot fetch BEFORE the bootstrap starts, then a live
    // `bootstrap: failed` event lands while that fetch is in flight. When the (older) snapshot
    // finally resolves it does not contain the run at all — mapping over the snapshot alone
    // would silently drop it, stranding the frame with no further event to correct it.
    store.upsertBootstrap(job('j1', { status: 'failed', updatedAt: 5 }))
    store.hydrate([], 'ws_test') // stale snapshot: fetched before the run existed
    expect(store.bootstrapJobs[0]?.status).toBe('failed')
    expect(store.byBlock.blk_j1!.status).toBe('failed')
  })

  it('hydrate DROPS a cached run from a different workspace (board switch starts clean)', () => {
    store.upsertBootstrap(job('j1', { status: 'failed', updatedAt: 5, workspaceId: 'ws_other' }))
    // Switching to ws_test: its snapshot must not leak the previous board's run.
    store.hydrate([job('j2', { workspaceId: 'ws_test' })], 'ws_test')
    expect(store.bootstrapJobs.map((j) => j.id)).toEqual(['j2'])
  })

  it('hydrate DOES apply a genuinely newer snapshot', () => {
    store.upsertBootstrap(job('j1', { status: 'running', updatedAt: 2 }))
    store.hydrate([job('j1', { status: 'succeeded', updatedAt: 9 })], 'ws_test')
    expect(store.bootstrapJobs[0]!.status).toBe('succeeded')
  })

  it('upsertBootstrap ignores an older/out-of-order event but applies newer/equal', () => {
    store.upsertBootstrap(job('j1', { status: 'failed', updatedAt: 5 }))
    store.upsertBootstrap(job('j1', { status: 'running', updatedAt: 3 })) // stale → ignored
    expect(store.bootstrapJobs[0]!.status).toBe('failed')
    store.upsertBootstrap(job('j1', { status: 'succeeded', updatedAt: 5 })) // equal → applied
    expect(store.bootstrapJobs[0]!.status).toBe('succeeded')
  })
})

/** Minimal EnvConfigRepairJob factory — only the fields the store touches. */
function repairJob(id: string, over: Partial<EnvConfigRepairJob> = {}): EnvConfigRepairJob {
  return {
    id,
    workspaceId: 'ws_test',
    owner: 'acme',
    repo: 'svc',
    branch: 'main',
    status: 'running',
    ok: null,
    issues: [],
    subtasks: null,
    error: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('agentRuns store — env-config-repair (plain useUpsertList adoption, candidate #3)', () => {
  let store: ReturnType<typeof useAgentRunsStore>
  beforeEach(() => {
    store = useAgentRunsStore()
  })

  it('upsertEnvConfigRepair prepends a new run (newest-first) and replaces in place by id', () => {
    store.upsertEnvConfigRepair(repairJob('r1'))
    store.upsertEnvConfigRepair(repairJob('r2'))
    // Newest prepended, so r2 leads r1.
    expect(store.envConfigRepairJobs.map((j) => j.id)).toEqual(['r2', 'r1'])
    // A later event for r1 replaces it IN PLACE (no reorder), unlike a monotonic-guarded list.
    store.upsertEnvConfigRepair(repairJob('r1', { status: 'succeeded' }))
    expect(store.envConfigRepairJobs.map((j) => j.id)).toEqual(['r2', 'r1'])
    expect(store.envConfigRepairById('r1')?.status).toBe('succeeded')
  })

  it('envConfigRepairById looks a run up by id (absent → undefined)', () => {
    store.upsertEnvConfigRepair(repairJob('r1'))
    expect(store.envConfigRepairById('r1')?.id).toBe('r1')
    expect(store.envConfigRepairById('nope')).toBeUndefined()
  })

  it('hydrateEnvConfigRepair replaces the cache newest-first', () => {
    store.upsertEnvConfigRepair(repairJob('stale'))
    store.hydrateEnvConfigRepair([
      repairJob('old', { createdAt: 1 }),
      repairJob('new', { createdAt: 9 }),
    ])
    expect(store.envConfigRepairJobs.map((j) => j.id)).toEqual(['new', 'old'])
  })
})

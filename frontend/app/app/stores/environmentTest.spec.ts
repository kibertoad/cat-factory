import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EnvironmentTestRun } from '~/types/domain'
import { useEnvironmentTestStore } from '~/stores/environmentTest'

// The store resolves `useApi()` at setup; override the inert global stub from
// `test/setup.ts` with a per-suite mock so the hydrate reconcile point-read is observable.
const apiMock = { getEnvironmentTest: vi.fn() }
vi.stubGlobal('useApi', () => apiMock)

/** Minimal EnvironmentTestRun factory — only the fields the store's reconcile logic touches. */
function run(id: string, over: Partial<EnvironmentTestRun> = {}): EnvironmentTestRun {
  return {
    id,
    workspaceId: 'ws_test',
    blockId: `blk_${id}`,
    status: 'running',
    stage: 'provisioning',
    branch: null,
    envUrl: null,
    error: null,
    failedStage: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('environmentTest store — monotonic run reconcile', () => {
  let store: ReturnType<typeof useEnvironmentTestStore>
  beforeEach(() => {
    apiMock.getEnvironmentTest = vi.fn(async () => {
      throw new Error('not stubbed')
    })
    store = useEnvironmentTestStore()
  })

  it('hydrate does NOT regress a run a newer live event already advanced', () => {
    // A live `envTest: failed` event landed first (newer updatedAt).
    store.upsert(run('r1', { status: 'failed', failedStage: 'provisioning', updatedAt: 5 }))
    // A lagging `workspace.refresh()` then hydrates a STALE snapshot that still saw the run
    // as `running` (older updatedAt) — it must NOT clobber the terminal state (terminal runs
    // emit nothing further, so the inspector would be stuck on "testing" forever).
    store.hydrate([run('r1', { status: 'running', updatedAt: 2 })], 'ws_test')
    expect(store.runForBlock('blk_r1')!.status).toBe('failed')
  })

  it('hydrate does NOT drop a live-added run the stale snapshot never saw', () => {
    // Terminal runs are omitted from the snapshot BY DESIGN, so a just-finished run the
    // inspector still shows must survive a full refresh.
    store.upsert(run('r1', { status: 'succeeded', stage: 'done', updatedAt: 5 }))
    store.hydrate([], 'ws_test')
    expect(store.runForBlock('blk_r1')!.status).toBe('succeeded')
  })

  it('hydrate point-reads a preserved RUNNING run the snapshot omitted (finished offline)', async () => {
    // The run was still `running` when the socket dropped; it finished while disconnected, so
    // the reconnect snapshot no longer carries it and no event replays — the hydrate must
    // re-read it to pick up the outcome instead of stranding a stale "testing" state.
    store.upsert(run('r1', { status: 'running', updatedAt: 5 }))
    apiMock.getEnvironmentTest = vi.fn(async () =>
      run('r1', { status: 'succeeded', stage: 'done', updatedAt: 9 }),
    )
    store.hydrate([], 'ws_test')
    expect(apiMock.getEnvironmentTest).toHaveBeenCalledWith('ws_test', 'r1')
    await vi.waitFor(() => expect(store.runForBlock('blk_r1')!.status).toBe('succeeded'))
  })

  it('a STALE point-read cannot regress a run a live event advanced meanwhile', async () => {
    store.upsert(run('r1', { status: 'running', updatedAt: 5 }))
    // The reconcile read resolves with an OLDER view of the run than the live event that
    // lands while it is in flight — the monotonic upsert must keep the newer state.
    apiMock.getEnvironmentTest = vi.fn(async () => run('r1', { status: 'running', updatedAt: 4 }))
    store.hydrate([], 'ws_test')
    store.upsert(run('r1', { status: 'failed', failedStage: 'tearing_down', updatedAt: 8 }))
    await vi.waitFor(() => expect(apiMock.getEnvironmentTest).toHaveBeenCalled())
    await Promise.resolve()
    expect(store.runForBlock('blk_r1')!.status).toBe('failed')
  })

  it('hydrate DROPS a cached run from a different workspace (board switch starts clean)', () => {
    store.upsert(run('r1', { status: 'failed', updatedAt: 5, workspaceId: 'ws_other' }))
    store.hydrate([run('r2', { workspaceId: 'ws_test' })], 'ws_test')
    expect(store.runs.map((r) => r.id)).toEqual(['r2'])
  })

  it('hydrate DOES apply a genuinely newer snapshot', () => {
    store.upsert(run('r1', { status: 'running', updatedAt: 2 }))
    store.hydrate([run('r1', { status: 'running', stage: 'tearing_down', updatedAt: 9 })], 'ws_test')
    expect(store.runForBlock('blk_r1')!.stage).toBe('tearing_down')
  })

  it('upsert ignores an older/out-of-order write but applies newer/equal', () => {
    store.upsert(run('r1', { status: 'failed', updatedAt: 5 }))
    // e.g. a `start()` response resolving AFTER the fast-failing run's terminal event landed.
    store.upsert(run('r1', { status: 'running', stage: 'creating_branch', updatedAt: 3 }))
    expect(store.runForBlock('blk_r1')!.status).toBe('failed')
    store.upsert(run('r1', { status: 'succeeded', stage: 'done', updatedAt: 5 }))
    expect(store.runForBlock('blk_r1')!.status).toBe('succeeded')
  })
})

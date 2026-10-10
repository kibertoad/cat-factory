import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useServiceSpecStore } from '~/stores/serviceSpec'
import { useWorkspaceStore } from '~/stores/workspace'
import type { ServiceSpecView } from '~/types/spec'

// The store holds TWO spec reads, and which one a caller takes is a correctness matter rather
// than a caching detail. The service read is the repo's DEFAULT branch ("what does this service
// require", the inspector's requirements window); the run read is the branch ONE RUN pushed to
// ("what did this run rule on", the outcome card's requirement join). While a pull request is
// open they are different trees, and the card joining against the first showed every requirement
// the run itself added as "not checked" while `/api/v1/runs/:runId/outcome` said otherwise.
//
// So what is pinned here is that the two never answer for each other: one key space cannot serve
// the other's question even when a block id and an execution id happen to collide.

function view(service: string): ServiceSpecView {
  return {
    present: true,
    spec: { service, summary: '', modules: [] },
    features: [],
  } as unknown as ServiceSpecView
}

function stubApi(over: Record<string, unknown> = {}) {
  vi.stubGlobal('useApi', () => ({
    getServiceSpec: () => Promise.resolve(view('from-default-branch')),
    getRunSpec: () => Promise.resolve(view('from-run-branch')),
    ...over,
  }))
}

beforeEach(() => {
  useWorkspaceStore().workspaceId = 'ws1'
  stubApi()
})

describe('serviceSpec store', () => {
  it('reads a run’s spec from the run endpoint, not the service one', async () => {
    const store = useServiceSpecStore()
    await store.loadForRun('exec_1')
    expect(store.viewForRun('exec_1')?.spec?.service).toBe('from-run-branch')
  })

  it('keeps the two reads in separate key spaces', async () => {
    // Same id, two questions. Without the prefixes one load would satisfy the other's accessor
    // and the card would silently join against the default branch again.
    const store = useServiceSpecStore()
    await store.load('id_1')
    await store.loadForRun('id_1')
    expect(store.viewFor('id_1')?.spec?.service).toBe('from-default-branch')
    expect(store.viewForRun('id_1')?.spec?.service).toBe('from-run-branch')
  })

  it('does not answer a run read out of the service cache', async () => {
    const store = useServiceSpecStore()
    await store.load('id_1')
    expect(store.viewForRun('id_1')).toBeUndefined()
  })

  it('coalesces overlapping loads of one run onto a single request', async () => {
    let calls = 0
    stubApi({
      getRunSpec: () => {
        calls += 1
        return Promise.resolve(view('from-run-branch'))
      },
    })
    const store = useServiceSpecStore()
    await Promise.all([store.loadForRun('exec_1'), store.loadForRun('exec_1')])
    expect(calls).toBe(1)
  })

  it('records a failed run read without poisoning the cached view', async () => {
    stubApi({ getRunSpec: () => Promise.reject(new Error('offline')) })
    const store = useServiceSpecStore()
    await store.loadForRun('exec_1')
    // The card composes `spec: 'not_read'` off an absent view and says so; a fabricated empty
    // view would have read as a service that declares nothing.
    expect(store.viewForRun('exec_1')).toBeUndefined()
  })
})

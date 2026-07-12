import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useKaizenStore } from '~/stores/kaizen'
import { useWorkspaceStore } from '~/stores/workspace'
import type { KaizenGrading } from '~/types/domain'

/** Minimal grading factory — only the fields the store reconciles/reads. */
function grading(over: Partial<KaizenGrading> = {}): KaizenGrading {
  return {
    id: 'g1',
    executionId: 'exec1',
    blockId: 'blk1',
    stepIndex: 0,
    agentKind: 'coder',
    model: 'm',
    promptVersion: 1,
    comboKey: 'coder|m|1',
    status: 'complete',
    grade: 5,
    summary: '',
    recommendations: [],
    graderModel: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as KaizenGrading
}

describe('kaizen store — live-push clobber guards', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('loadForExecution stores the fetched gradings', async () => {
    vi.stubGlobal('useApi', () => ({
      getKaizenForExecution: () => Promise.resolve({ gradings: [grading()] }),
    }))
    const store = useKaizenStore()
    await store.loadForExecution('exec1')
    expect(store.byExecution.exec1).toHaveLength(1)
  })

  it('a slower stale loadForExecution never clobbers a newer one (monotonic guard)', async () => {
    // Two loads race for the same execution: the FIRST-issued resolves LAST with a stale list.
    // Without the ticket guard its REPLACE would overwrite the fresher second result.
    const deferred: Array<(r: { gradings: KaizenGrading[] }) => void> = []
    vi.stubGlobal('useApi', () => ({
      getKaizenForExecution: () =>
        new Promise<{ gradings: KaizenGrading[] }>((res) => deferred.push(res)),
    }))
    const store = useKaizenStore()
    const first = store.loadForExecution('exec1') // issued #1 (stale)
    const second = store.loadForExecution('exec1') // issued #2 (fresh)

    deferred[1]!({ gradings: [grading({ id: 'fresh' })] })
    deferred[0]!({ gradings: [grading({ id: 'stale' })] })
    await Promise.all([first, second])

    expect(store.byExecution.exec1).toHaveLength(1)
    expect(store.byExecution.exec1![0]!.id).toBe('fresh')
  })

  it('a grading pushed live mid-load survives the load (merge, not blind-replace)', async () => {
    // A load is in flight (server response predates the newest grading); a live `upsert` lands
    // its grading; then the load resolves. A blind replace would drop the live-only grading.
    let resolveFetch!: (r: { gradings: KaizenGrading[] }) => void
    const pending = new Promise<{ gradings: KaizenGrading[] }>((res) => {
      resolveFetch = res
    })
    vi.stubGlobal('useApi', () => ({ getKaizenForExecution: () => pending }))
    const store = useKaizenStore()

    const load = store.loadForExecution('exec1')
    // A live stream event arrives while the fetch is in flight.
    store.upsert(grading({ id: 'live', stepIndex: 1 }))
    // The load's (staler) response comes back with only the earlier grading.
    resolveFetch({ gradings: [grading({ id: 'g1', stepIndex: 0 })] })
    await load

    const ids = store.byExecution.exec1!.map((g) => g.id).sort()
    expect(ids).toEqual(['g1', 'live'])
  })

  it('a shared-id load keeps whichever updatedAt is newer', async () => {
    // Stub before the store is created — it captures `useApi()` at instantiation.
    vi.stubGlobal('useApi', () => ({
      getKaizenForExecution: () =>
        Promise.resolve({ gradings: [grading({ id: 'g1', updatedAt: 2, summary: 'stale' })] }),
    }))
    const store = useKaizenStore()
    // Seed a fresher live grading, then a load returns a staler copy of the SAME id.
    store.upsert(grading({ id: 'g1', updatedAt: 5, summary: 'live' }))
    await store.loadForExecution('exec1')
    expect(store.byExecution.exec1![0]!.summary).toBe('live')
  })

  it('loadOverview preserves a live-pushed grading in history (merge, newest-first)', async () => {
    vi.stubGlobal('useApi', () => ({
      getKaizenOverview: () =>
        Promise.resolve({
          gradings: [grading({ id: 'old', createdAt: 1, updatedAt: 1 })],
          verified: [],
        }),
    }))
    const store = useKaizenStore()
    // A grading arrives live before the overview list is fetched.
    store.upsert(grading({ id: 'live', createdAt: 9, updatedAt: 9 }))
    await store.loadOverview()

    const ids = store.history.map((g) => g.id)
    expect(ids).toContain('live')
    expect(ids).toContain('old')
    // The live (newest) grading stays at the front of the newest-first list.
    expect(ids[0]).toBe('live')
  })

  it('a slower stale loadOverview never clobbers a newer one', async () => {
    const deferred: Array<(r: { gradings: KaizenGrading[]; verified: [] }) => void> = []
    vi.stubGlobal('useApi', () => ({
      getKaizenOverview: () =>
        new Promise<{ gradings: KaizenGrading[]; verified: [] }>((res) => deferred.push(res)),
    }))
    const store = useKaizenStore()
    const first = store.loadOverview() // stale
    const second = store.loadOverview() // fresh

    deferred[1]!({ gradings: [grading({ id: 'fresh' })], verified: [] })
    deferred[0]!({ gradings: [grading({ id: 'stale' })], verified: [] })
    await Promise.all([first, second])

    expect(store.history).toHaveLength(1)
    expect(store.history[0]!.id).toBe('fresh')
  })
})

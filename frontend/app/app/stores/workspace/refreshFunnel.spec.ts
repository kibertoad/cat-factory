import { describe, it, expect } from 'vitest'
import { createRefreshFunnel } from '~/stores/workspace/refreshFunnel'
import type { WorkspaceSnapshot } from '~/types/domain'
import type { LiveWriteBaselines } from '~/stores/workspace/hydrate'

interface Harness {
  readonly funnel: ReturnType<typeof createRefreshFunnel>
  /** Resolve the oldest pending fetch with a snapshot naming `label`. */
  readonly settle: (label: string) => Promise<void>
  /** Reject the oldest pending fetch. */
  readonly fail: (message?: string) => Promise<void>
  readonly fetches: () => number
  readonly applied: () => string[]
  setWorkspaceId: (id: string | null) => void
}

function harness(initialId: string | null = 'ws1'): Harness {
  let workspaceId = initialId
  const pending: { resolve: (s: WorkspaceSnapshot) => void; reject: (e: Error) => void }[] = []
  let fetches = 0
  const applied: string[] = []
  const baselines = {} as LiveWriteBaselines

  const funnel = createRefreshFunnel({
    currentWorkspaceId: () => workspaceId,
    fetchSnapshot: () => {
      fetches++
      return new Promise<WorkspaceSnapshot>((resolve, reject) => pending.push({ resolve, reject }))
    },
    captureBaselines: () => baselines,
    apply: (snapshot) => applied.push(snapshot.workspace.id),
  })

  /** Let the funnel's internal continuations run before the assertions read its state. */
  const drain = () => new Promise<void>((r) => setTimeout(r, 0))

  return {
    funnel,
    settle: async (label) => {
      pending.shift()!.resolve({ workspace: { id: label } } as unknown as WorkspaceSnapshot)
      await drain()
    },
    fail: async (message = 'offline') => {
      pending.shift()!.reject(new Error(message))
      await drain()
    },
    fetches: () => fetches,
    applied: () => applied,
    setWorkspaceId: (id) => {
      workspaceId = id
    },
  }
}

describe('refresh funnel', () => {
  it('fetches and hydrates a single refresh', async () => {
    const h = harness()
    const done = h.funnel.refresh()
    expect(h.fetches()).toBe(1)
    await h.settle('snap1')
    await done
    expect(h.applied()).toEqual(['snap1'])
  })

  /**
   * The coalescing rule. Callers arriving during a fetch share ONE follow-up, so N of them cost
   * one extra fetch between them rather than N.
   */
  it('collapses callers arriving during a fetch into one follow-up', async () => {
    const h = harness()
    const first = h.funnel.refresh()
    const a = h.funnel.refresh()
    const b = h.funnel.refresh()
    const c = h.funnel.refresh()
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(h.fetches()).toBe(1)

    await h.settle('snap1')
    await first
    expect(h.fetches()).toBe(2)
    await h.settle('snap2')
    await Promise.all([a, b, c])
    expect(h.applied()).toEqual(['snap1', 'snap2'])
  })

  /**
   * The reason plain single-flight is wrong here. A caller that mutated and then refreshed must
   * observe a snapshot READ AFTER its call: handing it the in-flight fetch (issued before the
   * mutation committed) would show it the pre-mutation world.
   */
  it('never hands a late caller the result of a fetch that was already in flight', async () => {
    const h = harness()
    const early = h.funnel.refresh()
    const late = h.funnel.refresh()
    await h.settle('before-mutation')
    await early
    // The late caller is still waiting: its own fetch has only just been issued.
    expect(h.applied()).toEqual(['before-mutation'])
    await h.settle('after-mutation')
    await late
    expect(h.applied()).toEqual(['before-mutation', 'after-mutation'])
  })

  it('still serves the queued caller when the in-flight fetch fails', async () => {
    const h = harness()
    const rejects = expect(h.funnel.refresh()).rejects.toThrow('offline')
    const queued = h.funnel.refresh()
    await h.fail()
    await rejects
    expect(h.fetches()).toBe(2)
    await h.settle('recovered')
    await queued
    expect(h.applied()).toEqual(['recovered'])
  })

  it('propagates a failure to the caller that issued the fetch', async () => {
    const h = harness()
    // Attach the expectation BEFORE rejecting: `fail` yields to the microtask queue, and an
    // unobserved rejection in that window is reported as unhandled.
    const rejects = expect(h.funnel.refresh()).rejects.toThrow('boom')
    await h.fail('boom')
    await rejects
    expect(h.applied()).toEqual([])
  })

  it('does nothing before a workspace is open', async () => {
    const h = harness(null)
    await h.funnel.refresh()
    expect(h.fetches()).toBe(0)
    expect(h.applied()).toEqual([])
  })

  it('discards a snapshot whose board was switched away from mid-fetch', async () => {
    const h = harness()
    const done = h.funnel.refresh()
    h.setWorkspaceId('ws2')
    await h.settle('stale')
    await done
    expect(h.applied()).toEqual([])
  })

  describe('coverage mark', () => {
    it('reports a fetch that started after the mark and hydrated', async () => {
      const h = harness()
      const mark = h.funnel.refreshMark()
      const done = h.funnel.refresh()
      expect(h.funnel.hydratedSince(mark)).toBe(false)
      await h.settle('snap1')
      await done
      expect(h.funnel.hydratedSince(mark)).toBe(true)
    })

    // The mark is taken when a coarse event arrives. A fetch ALREADY in flight may have been
    // issued before that event, so it must not read as coverage for it.
    it('does not count a fetch that was already in flight when the mark was taken', async () => {
      const h = harness()
      const done = h.funnel.refresh()
      const mark = h.funnel.refreshMark()
      await h.settle('in-flight-before-the-event')
      await done
      expect(h.funnel.hydratedSince(mark)).toBe(false)
    })

    it('does not count a fetch that failed or was discarded', async () => {
      const h = harness()
      const mark = h.funnel.refreshMark()
      const rejects = expect(h.funnel.refresh()).rejects.toThrow()
      await h.fail()
      await rejects
      expect(h.funnel.hydratedSince(mark)).toBe(false)

      const mark2 = h.funnel.refreshMark()
      const discarded = h.funnel.refresh()
      h.setWorkspaceId('ws2')
      await h.settle('stale')
      await discarded
      expect(h.funnel.hydratedSince(mark2)).toBe(false)
    })
  })
})

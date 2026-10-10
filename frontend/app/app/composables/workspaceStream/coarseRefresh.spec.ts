import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createCoarseRefresh } from '~/composables/workspaceStream/coarseRefresh'

function harness() {
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = []
  let workspaceId: string | null = 'ws1'
  let stopped = false
  let mark = 0
  /** The mark a hydrated fetch was issued after, i.e. what `hydratedSince` answers against. */
  let hydratedAfter: number | null = null

  const coarse = createCoarseRefresh({
    stopped: () => stopped,
    currentWorkspaceId: () => workspaceId,
    refresh: () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })),
    refreshMark: () => mark,
    hydratedSince: (m) => hydratedAfter !== null && hydratedAfter > m,
  })

  return {
    coarse,
    refreshes: () => pending.length,
    settle: async (i = pending.length - 1) => {
      pending[i]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    },
    fail: async (i = pending.length - 1) => {
      pending[i]!.reject(new Error('offline'))
      await vi.advanceTimersByTimeAsync(0)
    },
    setWorkspaceId: (id: string | null) => {
      workspaceId = id
    },
    stop: () => {
      stopped = true
    },
    /** Pretend a direct `refresh()` call site already hydrated a snapshot issued just now. */
    coverNow: () => {
      mark += 1
      hydratedAfter = mark
    },
  }
}

describe('coarse refresh', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retries a transient failure with backoff', async () => {
    const h = harness()
    const done = h.coarse.withRetry('ws1')
    expect(h.refreshes()).toBe(1)
    await h.fail()
    expect(h.refreshes()).toBe(1) // still in backoff
    await vi.advanceTimersByTimeAsync(400)
    expect(h.refreshes()).toBe(2)
    await h.settle()
    await done
  })

  it('stops retrying once the stream stopped or the board switched', async () => {
    const h = harness()
    const done = h.coarse.withRetry('ws1')
    await h.fail()
    h.setWorkspaceId('ws2')
    await vi.advanceTimersByTimeAsync(400)
    await done
    expect(h.refreshes()).toBe(1)
  })

  /**
   * The readiness rule. `socket.onopen` announces `connected` off this promise, so a chain that
   * stands down for a NEWER one must hand its caller that newer chain: resolving on supersession
   * would announce a board whose reconcile has not run, which is exactly what gating the
   * announcement on the resync exists to prevent.
   */
  it('a superseded chain resolves only once the chain that replaced it has reconciled', async () => {
    const h = harness()
    let announced = false
    const open = h.coarse.withRetry('ws1').then(() => {
      announced = true
    })
    // The on-connect chain's first attempt fails, so it drops into backoff...
    await h.fail()
    // ...and a buffered coarse event starts a newer chain while it sleeps.
    const newer = h.coarse.withRetry('ws1')
    expect(h.refreshes()).toBe(2)

    // The older chain wakes, sees it has been superseded and stops issuing fetches of its own.
    await vi.advanceTimersByTimeAsync(400)
    expect(h.refreshes()).toBe(2)
    expect(announced).toBe(false)

    await h.settle()
    await Promise.all([open, newer])
    expect(announced).toBe(true)
  })

  describe('debounce', () => {
    it('collapses a burst of coarse events into one refresh', async () => {
      const h = harness()
      h.coarse.schedule()
      h.coarse.schedule()
      h.coarse.schedule()
      await vi.advanceTimersByTimeAsync(300)
      expect(h.refreshes()).toBe(1)
    })

    /**
     * `cancel()` must clear the window, not just the timer. The window start is read whenever a
     * window is already open, so a handle left behind here lets the first event of the NEXT session
     * inherit a start whose max-wait expired long ago and fire an undebounced full snapshot fetch.
     */
    it('debounces the first event after a cancel instead of firing immediately', async () => {
      const h = harness()
      h.coarse.schedule()
      h.coarse.cancel()
      // Long enough that the cancelled window's max-wait would have elapsed.
      await vi.advanceTimersByTimeAsync(3_000)
      expect(h.refreshes()).toBe(0)

      h.coarse.schedule()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.refreshes()).toBe(0)
      await vi.advanceTimersByTimeAsync(300)
      expect(h.refreshes()).toBe(1)
    })

    it('fires within the max wait under a sustained event stream', async () => {
      const h = harness()
      for (let i = 0; i < 12; i++) {
        h.coarse.schedule()
        await vi.advanceTimersByTimeAsync(200)
      }
      expect(h.refreshes()).toBeGreaterThan(0)
    })

    it('stands down when a snapshot issued after the event has already hydrated', async () => {
      const h = harness()
      h.coarse.schedule()
      h.coverNow()
      await vi.advanceTimersByTimeAsync(300)
      expect(h.refreshes()).toBe(0)
    })
  })
})

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
  /** The workspace ids the funnel actually fetched, in order. */
  readonly fetched: () => string[]
  readonly applied: () => string[]
  /** Whether the oldest pending fetch has been aborted. */
  readonly aborted: () => boolean
  setWorkspaceId: (id: string | null) => void
}

function harness(initialId: string | null = 'ws1', deadlineMs?: number): Harness {
  let workspaceId = initialId
  const pending: {
    resolve: (s: WorkspaceSnapshot) => void
    reject: (e: Error) => void
    signal: AbortSignal
  }[] = []
  const fetched: string[] = []
  const applied: string[] = []
  const baselines = {} as LiveWriteBaselines

  const funnel = createRefreshFunnel({
    currentWorkspaceId: () => workspaceId,
    fetchSnapshot: (id, signal) => {
      fetched.push(id)
      return new Promise<WorkspaceSnapshot>((resolve, reject) =>
        pending.push({ resolve, reject, signal }),
      )
    },
    captureBaselines: () => baselines,
    apply: (snapshot) => applied.push(snapshot.workspace.id),
    deadlineMs,
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
    fetches: () => fetched.length,
    fetched: () => fetched,
    applied: () => applied,
    aborted: () => pending[0]!.signal.aborted,
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

  /**
   * The queued follow-up is queued FOR a board. A switch while it waits makes it pointless, and
   * issuing it anyway would read the NEW board's snapshot on behalf of a caller that asked about
   * the old one, race the switch's own hydrate, and resolve as though the old board had refreshed.
   */
  it('does not fetch the new board on behalf of a follow-up queued for the old one', async () => {
    const h = harness()
    const first = h.funnel.refresh()
    const queued = h.funnel.refresh()
    h.setWorkspaceId('ws2')
    await h.settle('stale')
    await first
    await queued
    expect(h.fetched()).toEqual(['ws1'])
    expect(h.applied()).toEqual([])
  })

  /**
   * The slot is bounded, because serializing every refresh through it makes ONE stalled request
   * everyone's problem: the client sets no timeout, so a dropped connection would otherwise leave
   * the funnel holding a fetch that never settles and every later caller queued behind it forever.
   */
  describe('deadline', () => {
    /**
     * The deadline is per FUNNEL, so a test that both times a fetch out AND then drives a second
     * one to completion needs a value that satisfies both halves. The first half is satisfied by
     * any value (its fetch never settles, so the timer always wins in the end, it just waits that
     * long); the second is satisfied only while every turn AFTER the timeout fits inside the same
     * budget. Sized at 5ms that budget was two macrotask turns plus assertions, which a loaded CI
     * runner overruns: the recovery fetch timed out instead, the test failed on its own deadline
     * and the abandoned promise surfaced as an unhandled rejection. So this is deliberately
     * generous and must NOT be tightened for speed: it costs one wait, and what it buys is a
     * timing assumption the runner cannot break.
     */
    const GENEROUS_DEADLINE_MS = 250

    it('fails the caller, aborts the request and frees the slot when a fetch never settles', async () => {
      const h = harness('ws1', GENEROUS_DEADLINE_MS)
      const stalled = expect(h.funnel.refresh()).rejects.toThrow(/timed out/)
      await stalled
      expect(h.aborted()).toBe(true)

      // The funnel is usable again: a fresh caller issues its own fetch rather than joining the
      // hang, and the abandoned request can no longer hydrate anything if it does answer.
      const next = h.funnel.refresh()
      expect(h.fetches()).toBe(2)
      await h.settle('late-answer-from-the-abandoned-fetch')
      expect(h.applied()).toEqual([])
      await h.settle('recovered')
      await next
      expect(h.applied()).toEqual(['recovered'])
    })

    // Nothing here outlives the timeout, so this one can stay fast.
    it('does not count a timed-out fetch as coverage', async () => {
      const h = harness('ws1', 5)
      const mark = h.funnel.refreshMark()
      await expect(h.funnel.refresh()).rejects.toThrow(/timed out/)
      expect(h.funnel.hydratedSince(mark)).toBe(false)
    })
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

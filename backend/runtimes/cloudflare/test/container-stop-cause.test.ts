import { describe, expect, it } from 'vitest'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import { CloudflareContainerTransport } from '../src/infrastructure/containers/CloudflareContainerTransport'
import type { ExecutionContainer } from '../src/infrastructure/containers/ExecutionContainer'
import {
  ATTRIBUTION_WINDOW_MS,
  type ContainerStopCause,
  recordStopCause,
  type StopCauseStorage,
  takeStopCause,
} from '../src/infrastructure/containers/stopCause'

// Telling a container RECLAIM apart from a container CRASH (stuck-run audit F12).
//
// A job poll that 404s means the container is gone, and nothing in the 404 says why. The engine
// spends a budget of ONE on a crash (a second crash of the same step is deterministic and ends
// the run) and a budget of FIVE on infrastructure churn. So a reclaim read as a crash costs a
// healthy run its recovery: two poll-scheduling hiccups in one step, each idling the container
// out, and the run fails `evicted` with nothing actually wrong.

const NOW = 1_700_000_000_000

/** The three storage methods the bookkeeping uses, over a plain Map. */
function fakeStorage(): StopCauseStorage & { size: () => number } {
  const rows = new Map<string, unknown>()
  return {
    get: async (key) => rows.get(key),
    put: async (key, value) => void rows.set(key, value),
    delete: async (key) => rows.delete(key),
    size: () => rows.size,
  }
}

/** A namespace whose poll 404s, with the container answering `cause` about its own reclaim. */
function namespace404(
  cause: ContainerStopCause | undefined,
): DurableObjectNamespace<ExecutionContainer> {
  const stub = {
    fetch: () => Promise.resolve(new Response('no such job', { status: 404 })),
    recentEvictionCause: () => Promise.resolve(cause),
  }
  return {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: () => stub,
  } as unknown as DurableObjectNamespace<ExecutionContainer>
}

describe('stop-cause bookkeeping', () => {
  it('attributes a reclaim observed inside its window', async () => {
    const storage = fakeStorage()
    await recordStopCause(storage, 'idle', NOW)

    expect(await takeStopCause(storage, NOW + ATTRIBUTION_WINDOW_MS.idle)).toBe('idle')
  })

  it('forgets a reclaim the poll found too late to explain', async () => {
    // The container recovered and ran on, so whatever killed it later is its own death, not
    // this one's. Without the window a single reclaim would excuse every eviction after it.
    const storage = fakeStorage()
    await recordStopCause(storage, 'idle', NOW)

    expect(await takeStopCause(storage, NOW + ATTRIBUTION_WINDOW_MS.idle + 1)).toBeUndefined()
  })

  it('gives an idle reclaim a wider window than a rollout, because it is found later', async () => {
    // A rollout drain interrupts an IN-FLIGHT poll; an idle reclaim happens precisely because
    // polling stopped, so the poll that discovers it arrives however long the gap outran the
    // idle window. One window for both would read every real idle reclaim as a crash, which is
    // the finding itself, so the ordering is the property worth pinning, not either number.
    expect(ATTRIBUTION_WINDOW_MS.idle).toBeGreaterThan(ATTRIBUTION_WINDOW_MS.rollout)

    const storage = fakeStorage()
    await recordStopCause(storage, 'rollout', NOW)
    expect(await takeStopCause(storage, NOW + ATTRIBUTION_WINDOW_MS.idle)).toBeUndefined()
  })

  it('consumes the record, so one reclaim explains exactly one eviction', async () => {
    // The engine answers an eviction by re-dispatching onto a FRESH container under the same DO
    // id. A record left behind would still be there to excuse that container's death too.
    const storage = fakeStorage()
    await recordStopCause(storage, 'idle', NOW)

    expect(await takeStopCause(storage, NOW)).toBe('idle')
    expect(await takeStopCause(storage, NOW)).toBeUndefined()
    expect(storage.size()).toBe(0)
  })

  it('attributes nothing to a persisted cause this build no longer knows', async () => {
    // The vocabulary is closed and the record is PERSISTED, so a deploy that retires a cause
    // leaves rows naming it. Falling back to "no attribution" reports the eviction as the crash
    // it may well have been, which costs a run one restart rather than wrongly granting four.
    const storage = fakeStorage()
    await storage.put('containerStopCause', { cause: 'stargate', at: NOW } as never)

    expect(await takeStopCause(storage, NOW)).toBeUndefined()
  })
})

describe('CloudflareContainerTransport 404 classification', () => {
  const ref = { runId: 'run-1', jobId: 'job-1' }

  it('reports an unexplained 404 as a crash', async () => {
    const view = await new CloudflareContainerTransport(namespace404(undefined)).poll(ref)

    expect(view.evicted).toBe('crash')
    expect(view.error).toBe('Job not found (container evicted or crashed)')
  })

  it('recovers an idle reclaim on the transient budget, and says which churn it was', async () => {
    const view = await new CloudflareContainerTransport(namespace404('idle')).poll(ref)

    // `transient` is what buys the larger recovery budget; the wording is what tells an
    // operator to look at poll scheduling rather than at the last deploy.
    expect(view.evicted).toBe('transient')
    expect(view.error).toContain('idle container reclaimed between polls')
  })

  it('keeps the rollout wording distinct from the idle one', async () => {
    const view = await new CloudflareContainerTransport(namespace404('rollout')).poll(ref)

    expect(view.evicted).toBe('transient')
    expect(view.error).toContain('transient infrastructure eviction')
  })
})

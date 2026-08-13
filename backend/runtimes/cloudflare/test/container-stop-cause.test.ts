import { describe, expect, it } from 'vitest'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import { CloudflareContainerTransport } from '../src/infrastructure/containers/CloudflareContainerTransport'
import type { ExecutionContainer } from '../src/infrastructure/containers/ExecutionContainer'
import {
  ATTRIBUTION_WINDOW_MS,
  clearStopCause,
  EXIT_ATTRIBUTION_WINDOW_MS,
  observationForStop,
  recordStopCause,
  STOP_MERGE_WINDOW_MS,
  type StopCauseStorage,
  type StopObservation,
  takeStopCause,
} from '../src/infrastructure/containers/stopCause'

// Telling a container RECLAIM apart from a container CRASH (stuck-run audit F12).
//
// A job poll that 404s means the container is gone, and nothing in the 404 says why. The engine
// spends a budget of ONE on a crash (a second crash of the same step is deterministic and ends
// the run) and a budget of FIVE on infrastructure churn. So a reclaim read as a crash costs a
// healthy run its recovery: two poll-scheduling hiccups in one step, each idling the container
// out, and the run fails `evicted` with nothing actually wrong.
//
// The reverse mistake is the one the rules below mostly guard: a record that outlives what it can
// honestly explain hands the NEXT death an alibi, and the death it excuses is the OOM the small
// budget exists to catch.

const NOW = 1_700_000_000_000
const JOB = 'job-1'

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

/** A namespace whose poll 404s, with the container answering `observed` about its own stop. */
function namespace404(
  observed: StopObservation,
): DurableObjectNamespace<ExecutionContainer> & { claims: string[] } {
  const claims: string[] = []
  const stub = {
    fetch: () => Promise.resolve(new Response('no such job', { status: 404 })),
    recentStopObservation: (jobId: string) => {
      claims.push(jobId)
      return Promise.resolve(observed)
    },
  }
  return {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: () => stub,
    claims,
  } as unknown as DurableObjectNamespace<ExecutionContainer> & { claims: string[] }
}

describe('stop-cause bookkeeping', () => {
  it('attributes a reclaim observed inside its window', async () => {
    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'idle' }, NOW)

    expect(await takeStopCause(storage, NOW + ATTRIBUTION_WINDOW_MS.idle, JOB)).toEqual({
      cause: 'idle',
    })
  })

  it('forgets a reclaim the poll found too late to explain', async () => {
    // The container recovered and ran on, so whatever killed it later is its own death, not
    // this one's. Without the window a single reclaim would excuse every eviction after it.
    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'idle' }, NOW)

    expect(await takeStopCause(storage, NOW + ATTRIBUTION_WINDOW_MS.idle + 1, JOB)).toEqual({})
  })

  it('gives an idle reclaim a wider window than a rollout, because it is found later', async () => {
    // A rollout drain interrupts an IN-FLIGHT poll; an idle reclaim happens precisely because
    // polling stopped, so the poll that discovers it arrives however long the gap outran the
    // idle window. One window for both would read every real idle reclaim as a crash, which is
    // the finding itself, so the ordering is the property worth pinning, not either number.
    expect(ATTRIBUTION_WINDOW_MS.idle).toBeGreaterThan(ATTRIBUTION_WINDOW_MS.rollout)

    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'rollout' }, NOW)
    expect(await takeStopCause(storage, NOW + ATTRIBUTION_WINDOW_MS.idle, JOB)).toEqual({})
  })

  it('spends a record on one job, so one reclaim explains exactly one eviction', async () => {
    // The engine answers an eviction by re-dispatching onto a FRESH container under the same DO
    // id. A record left readable would still be there to excuse that container's death too.
    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'idle' }, NOW)

    expect(await takeStopCause(storage, NOW, JOB)).toEqual({ cause: 'idle' })
    expect(await takeStopCause(storage, NOW, 'job-2')).toEqual({})
  })

  it('answers a REPLAYED poll for the same job identically', async () => {
    // The read runs inside a `step.do` that retries three times. A destructive read loses the
    // attribution when the step throws AFTER it (a contended persist, a failed emit), and the
    // retry then reports the crash this mechanism exists to spare — so the claim is keyed by the
    // job rather than the record being deleted.
    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'rollout' }, NOW)

    expect(await takeStopCause(storage, NOW, JOB)).toEqual({ cause: 'rollout' })
    expect(await takeStopCause(storage, NOW, JOB)).toEqual({ cause: 'rollout' })
  })

  it('drops a record when a new job is accepted, so it cannot excuse that job', async () => {
    // The routine case: a run parks on a human decision, nothing is running, and the container
    // idles out anyway. Left in place that marker sits inside its 30-minute window ready to
    // excuse the NEXT step's genuine OOM as churn — weakening the crash budget on the common
    // path rather than the rare one.
    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'idle' }, NOW)

    await clearStopCause(storage)

    expect(await takeStopCause(storage, NOW, 'job-after-dispatch')).toEqual({})
    expect(storage.size()).toBe(0)
  })

  it('keeps the exit state of a stop no cause explains, which is the crash case', async () => {
    // The whole point of recording an exit: the deaths with NO cause are exactly the ones an
    // operator cannot otherwise diagnose, and on this runtime the exit code is the only account
    // of them that exists (the container's stdout is unreadable from the Worker).
    const storage = fakeStorage()
    await recordStopCause(storage, { exit: { code: 137, reason: 'exit' } }, NOW)

    expect(await takeStopCause(storage, NOW, JOB)).toEqual({ exit: { code: 137, reason: 'exit' } })
  })

  it('merges the two hooks that each know half of one stop', async () => {
    // A rollout drain reaches the container through `onError` (which recognises the churn and
    // has no exit state) and `onStop` (which carries the exit state and cannot name the churn),
    // in either order. A plain overwrite means whichever landed second discarded the other's
    // half: the recovery budget or the only account of the death, depending on the day.
    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'rollout' }, NOW)
    await recordStopCause(storage, { exit: { code: 143, reason: 'runtime_signal' } }, NOW + 5)

    expect(await takeStopCause(storage, NOW + 10, JOB)).toEqual({
      cause: 'rollout',
      exit: { code: 143, reason: 'runtime_signal' },
    })
  })

  it('never merges onto a record from an EARLIER stop', async () => {
    // The merge exists for two hooks describing ONE death, moments apart. Records are not
    // reliably cleared between stops (an expired one is deliberately left in place, and only an
    // accepted dispatch deletes one), so a stale record is the ordinary state of a container
    // that idled out and was re-driven. Merging onto it back-dates the new observation to the
    // old stop's `at`, which ages it out of its own attribution window on arrival: the crash
    // that just happened is recorded, read back, and dropped as too old to explain itself.
    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'idle' }, NOW)

    const later = NOW + STOP_MERGE_WINDOW_MS + 1
    await recordStopCause(storage, { exit: { code: 137, reason: 'exit' } }, later)

    // The new stop stands alone, dated to itself, and is still attributable a poll-gap later.
    expect(await takeStopCause(storage, later + EXIT_ATTRIBUTION_WINDOW_MS, JOB)).toEqual({
      exit: { code: 137, reason: 'exit' },
    })
  })

  it('never merges onto a record that already explained somebody', async () => {
    // A claimed record is spent. Anything observed after it belongs to the NEXT death, so
    // merging would resurrect a claimed record under a second job's name.
    const storage = fakeStorage()
    await recordStopCause(storage, { cause: 'idle' }, NOW)
    await takeStopCause(storage, NOW, JOB)

    await recordStopCause(storage, { exit: { code: 137, reason: 'exit' } }, NOW + 5)

    expect(await takeStopCause(storage, NOW + 5, 'job-2')).toEqual({
      exit: { code: 137, reason: 'exit' },
    })
  })

  it('ages the cause and the exit state independently', async () => {
    // They answer different questions: the cause decides a recovery BUDGET, the exit state only
    // ever decides a sentence on the failure detail. So a record too old to excuse an eviction as
    // churn is still the only account of how the container died, and dropping both together
    // would throw the diagnostic away to protect a budget it does not touch.
    expect(EXIT_ATTRIBUTION_WINDOW_MS).toBeGreaterThan(ATTRIBUTION_WINDOW_MS.rollout)

    const storage = fakeStorage()
    await recordStopCause(
      storage,
      { cause: 'rollout', exit: { code: 143, reason: 'runtime_signal' } },
      NOW,
    )

    expect(await takeStopCause(storage, NOW + ATTRIBUTION_WINDOW_MS.rollout + 1, JOB)).toEqual({
      exit: { code: 143, reason: 'runtime_signal' },
    })
  })

  it('records nothing for a stop the container itself asked for', async () => {
    // The idle reclaim and the shutdown RPC both work by SIGNALLING the container, so the exit
    // that comes back is this container's own request echoed at it, and it escalates to a
    // SIGKILL 137 whenever the workload does not exit inside the grace period. Recorded, that
    // is read back as a cause of death and reported as an out-of-memory kill under a verdict
    // saying the platform reclaimed an idle container.
    expect(observationForStop({ exitCode: 137, reason: 'exit' }, true)).toBeUndefined()
  })

  it('reads a runtime-signalled 143 as the rollout drain, whichever hook saw it', () => {
    // The same churn reaches `onError` or `onStop` depending on the runtime version, so the
    // cause has to be recognisable from the exit pair alone.
    expect(observationForStop({ exitCode: 143, reason: 'runtime_signal' }, false)).toEqual({
      cause: 'rollout',
      exit: { code: 143, reason: 'runtime_signal' },
    })
    // A plain workload exit of 143 is not a drain: the runtime did not signal it.
    expect(observationForStop({ exitCode: 143, reason: 'exit' }, false)).toEqual({
      exit: { code: 143, reason: 'exit' },
    })
  })

  it('attributes nothing to a persisted exit `reason` this build cannot word', async () => {
    // Same closed-vocabulary-plus-persistence trap as the cause below, and the same answer: an
    // unworded reason says less than the bare code already does, so it degrades to "nothing
    // recorded" rather than being spliced into an operator's sentence.
    const storage = fakeStorage()
    await storage.put('containerStopCause', {
      exit: { code: 137, reason: 'abducted' },
      at: NOW,
    } as never)

    expect(await takeStopCause(storage, NOW, JOB)).toEqual({})
  })

  it('attributes nothing to a persisted cause this build no longer knows', async () => {
    // The vocabulary is closed and the record is PERSISTED, so a deploy that retires a cause
    // leaves rows naming it. Falling back to "no attribution" reports the eviction as the crash
    // it may well have been, which costs a run one restart rather than wrongly granting four.
    const storage = fakeStorage()
    await storage.put('containerStopCause', { cause: 'stargate', at: NOW } as never)

    expect(await takeStopCause(storage, NOW, JOB)).toEqual({})
  })
})

describe('CloudflareContainerTransport 404 classification', () => {
  const ref = { runId: 'run-1', jobId: 'job-1' }

  it('reports an unexplained 404 as a crash', async () => {
    const view = await new CloudflareContainerTransport(namespace404({})).poll(ref)

    expect(view.evicted).toBe('crash')
    expect(view.error).toBe('Job not found (container evicted or crashed)')
  })

  it('reports a workload that exited 0 as a shutdown rather than a crash', async () => {
    // A container whose only workload is the harness cannot exit 0 while a job is in flight
    // unless something stopped it, and a fresh container meets that same something. Only read
    // where NOTHING else explains the stop: a reclaim we asked for records no observation at all,
    // and a named cause is churn, which recovers on the transient budget.
    const view = await new CloudflareContainerTransport(
      namespace404({ exit: { code: 0, reason: 'exit' } }),
    ).poll(ref)

    expect(view.harnessShutdown).toBe(true)
    expect(view.evicted).toBeUndefined()
    expect(view.error).not.toMatch(/evicted or crashed/)
  })

  it('keeps a rollout drain a transient eviction even when it exited 0', async () => {
    // The precedence that makes the rule above safe: infrastructure churn is named, recovers on
    // the larger budget, and must not be re-read as somebody shutting the harness down.
    const view = await new CloudflareContainerTransport(
      namespace404({ cause: 'rollout', exit: { code: 0, reason: 'exit' } }),
    ).poll(ref)

    expect(view.evicted).toBe('transient')
    expect(view.harnessShutdown).toBeUndefined()
  })

  it('attaches the container exit state to an otherwise unexplained crash', async () => {
    // The D1 finding on the DEPLOYED runtime: every container death reached the operator as the
    // bare sentinel string. The verdict is unchanged (a crash still spends the crash budget);
    // what is new is that the failure now says how the container died.
    const view = await new CloudflareContainerTransport(
      namespace404({ exit: { code: 137, reason: 'exit' } }),
    ).poll(ref)

    expect(view.evicted).toBe('crash')
    expect(view.detail).toContain('exit code 137')
    expect(view.detail).toContain('out-of-memory')
  })

  it('omits the detail entirely when the container observed nothing', async () => {
    // An absent detail and an empty one are different facts, and only the absence says "nothing
    // could be read" rather than "the container had nothing to say".
    const view = await new CloudflareContainerTransport(namespace404({})).poll(ref)

    expect(view.detail).toBeUndefined()
  })

  it('recovers an idle reclaim on the transient budget, and says which churn it was', async () => {
    const view = await new CloudflareContainerTransport(namespace404({ cause: 'idle' })).poll(ref)

    // `transient` is what buys the larger recovery budget; the wording is what tells an
    // operator to look at poll scheduling rather than at the last deploy.
    expect(view.evicted).toBe('transient')
    expect(view.error).toContain('idle container reclaimed between polls')
  })

  it('never lets the exit sentence contradict the verdict beside it', async () => {
    // The two halves are recorded independently and both are reported, so they routinely
    // describe one event twice. A reclaim is PERFORMED by signalling the container, and it
    // escalates to a SIGKILL when the workload does not exit in time, so a run correctly
    // reported as an idle reclaim can carry exit 137, and read as an unexplained death that
    // code says "most often an out-of-memory kill". The operator is then holding a verdict and
    // a detail that cannot both be true, with nothing to say which one to act on.
    const view = await new CloudflareContainerTransport(
      namespace404({ cause: 'idle', exit: { code: 137, reason: 'exit' } }),
    ).poll(ref)

    expect(view.error).toContain('idle container reclaimed between polls')
    // The mechanics still ride the detail: "reclaimed" and "reclaimed with a SIGKILL" are worth
    // telling apart. What is withheld is the second, competing cause of death.
    expect(view.detail).toContain('exit code 137')
    expect(view.detail).toContain('SIGKILL')
    expect(view.detail).not.toContain('out-of-memory')
  })

  it('keeps the rollout wording distinct from the idle one', async () => {
    const view = await new CloudflareContainerTransport(namespace404({ cause: 'rollout' })).poll(
      ref,
    )

    expect(view.evicted).toBe('transient')
    expect(view.error).toContain('transient infrastructure eviction')
  })

  it('claims the record under the POLLING job, not the run', async () => {
    // A run's container serves every step, so a record claimed by the run would be spent by the
    // first eviction and unreadable on a replay of that same step's poll.
    const namespace = namespace404({ cause: 'idle' })
    await new CloudflareContainerTransport(namespace).poll(ref)

    expect(namespace.claims).toEqual([ref.jobId])
  })

  it('spends the stored record even when it knows the cause itself', async () => {
    // A rollout in flight makes the container fetch THROW rather than 404, so this path derives
    // its verdict from the signal. It must still spend whatever the container recorded, or one
    // reclaim excuses this eviction and is left behind to excuse the next one too.
    const claims: string[] = []
    const namespace = {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => ({
        fetch: () => Promise.reject(new Error('new version rollout')),
        recentStopObservation: (jobId: string) => {
          claims.push(jobId)
          return Promise.resolve<StopObservation>({
            cause: 'idle',
            exit: { code: 143, reason: 'runtime_signal' },
          })
        },
      }),
    } as unknown as DurableObjectNamespace<ExecutionContainer>

    const view = await new CloudflareContainerTransport(namespace).poll(ref)

    // The cause the transport OBSERVED wins over the stored one: the container is mid-drain, and
    // what it recorded earlier is not what this poll just watched happen.
    expect(view.error).toContain('transient infrastructure eviction')
    expect(claims).toEqual([ref.jobId])
    // The exit state, though, can only ever come from the container, so it rides through the
    // branch that overrode the cause rather than being dropped with it.
    expect(view.detail).toContain('exit code 143')
  })
})

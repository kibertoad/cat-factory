import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdvanceResult, DriveConfig } from '@cat-factory/orchestration'
import { driveExecution } from '../src/execution/drive.js'

// The Node half of the engine's hang bound (stuck-run audit F9).
//
// `driveExecution`'s ceiling is a runtime-neutral SEAM with an inert default, exactly like its
// `sleep`: orchestration owns no timers, so a facade that forgets to wire the clock still
// typechecks and still drives runs. It just drives them unbounded, which is the bug F9
// records. This file pins that BOTH Node-side callers get the real clock, by driving through
// the same wrapper `pgBossRunner` and the mothership runner import.
//
// The ceiling matters because nothing else bounds an advance on Node: pg-boss heartbeats an
// ACTIVE job regardless of handler progress, so a hung call inside `advanceInstance` leaves the
// run `running` with a live job and a frozen `updated_at`: the stale-run sweeper classifies it
// `live` and skips it, and the run wedges until the queue's expire cap (up to 24h).
//
// FAKE timers, not a short real ceiling raced against `Date.now()`. A wall-clock assertion on a
// shared CI runner is a coin toss the product cannot lose but the suite can, and it could only
// ever observe that the drive returned EARLY — never the thing worth pinning, which is that the
// wrapper drops the timer it armed. `vi.getTimerCount()` observes that directly.

type Exec = Parameters<typeof driveExecution>[0]

const CFG: DriveConfig = {
  jobPollIntervalMs: 1,
  jobMaxPolls: 2,
  jobPollFailureTolerance: 1,
  ciPollIntervalMs: 1,
  ciMaxPolls: 2,
  // A production-shaped ceiling: the clock is faked, so nothing waits it out, and the failure
  // text below is the one an operator would actually read.
  advanceTimeoutMs: 5 * 60_000,
}

/** Records the terminal failure the driver settles a run with. */
interface Recorder {
  exec: Exec
  failures: string[]
}

function recorder(advance: () => Promise<AdvanceResult>): Recorder {
  const failures: string[] = []
  const exec = {
    advanceInstance: advance,
    failRun: async (_ws: string, _id: string, message: string, kind: string) => {
      failures.push(`${kind}:${message}`)
    },
  } as unknown as Exec
  return { exec, failures }
}

describe('Node advance ceiling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails a run whose advance never settles, rather than waiting on it', async () => {
    const r = recorder(() => new Promise<AdvanceResult>(() => {}))

    const drive = driveExecution(r.exec, 'ws', 'ex', CFG)
    // Nothing has fired yet: the ceiling is a bound on the advance, not a delay before it.
    expect(r.failures).toEqual([])

    await vi.advanceTimersByTimeAsync(CFG.advanceTimeoutMs)
    await drive

    expect(r.failures).toEqual(['timeout:Step advance did not complete within 5 minutes'])
  })

  it('drops the armed timer as soon as the advance settles', async () => {
    // The control case, and the one that would otherwise cost every healthy advance a timer held
    // open for the rest of the window. It also proves the assertion above is the ceiling firing
    // rather than the wrapper failing every run it drives.
    const r = recorder(async () => ({ kind: 'done' }) as AdvanceResult)

    await driveExecution(r.exec, 'ws', 'ex', CFG)

    expect(r.failures).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

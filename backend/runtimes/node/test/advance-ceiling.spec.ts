import { describe, expect, it } from 'vitest'
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

type Exec = Parameters<typeof driveExecution>[0]

const CFG: DriveConfig = {
  jobPollIntervalMs: 1,
  jobMaxPolls: 2,
  jobPollFailureTolerance: 1,
  ciPollIntervalMs: 1,
  ciMaxPolls: 2,
  // A real (timer-backed) ceiling, just short enough to assert against without the test waiting
  // out a production one. The value is what the wrapper races; the mechanism is identical.
  advanceTimeoutMs: 25,
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
  it('fails a run whose advance never settles, rather than waiting on it', async () => {
    const r = recorder(() => new Promise<AdvanceResult>(() => {}))

    await driveExecution(r.exec, 'ws', 'ex', CFG)

    expect(r.failures).toEqual(['timeout:Step advance did not complete within 25ms'])
  })

  it('leaves a healthy advance alone (the ceiling is a bound, not a deadline to wait out)', async () => {
    // The control case: the same wiring, with an advance that settles. It proves the assertion
    // above is the ceiling firing rather than the wrapper failing every run it drives, and
    // that a settled advance clears its timer instead of holding the drive open for the rest
    // of the window.
    const r = recorder(async () => ({ kind: 'done' }) as AdvanceResult)

    const started = Date.now()
    await driveExecution(r.exec, 'ws', 'ex', CFG)

    expect(r.failures).toEqual([])
    expect(Date.now() - started).toBeLessThan(CFG.advanceTimeoutMs)
  })
})

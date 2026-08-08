import { describe, expect, it } from 'vitest'
import { ConflictError, createRecordingLogger } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import { type DriveConfig, driveExecution } from './drive.js'

// `driveExecution`'s first parameter is the orchestration `ExecutionService`; deriving
// the type avoids importing the (heavy) class just for a scripted fake.
type Exec = Parameters<typeof driveExecution>[0]

const CFG: DriveConfig = {
  jobPollIntervalMs: 15_000,
  jobMaxPolls: 5,
  jobPollFailureTolerance: 3,
  ciPollIntervalMs: 30_000,
  ciMaxPolls: 5,
  // Unbounded by default: the scripted fakes settle synchronously, so the ceiling only
  // matters in the tests that opt into it with their own clock.
  advanceTimeoutMs: 0,
}

const AWAITING_JOB: AdvanceResult = { kind: 'awaiting_job', jobId: 'j1', stepIndex: 0 }
const AWAITING_GATE: AdvanceResult = { kind: 'awaiting_gate', stepIndex: 0 }
const DONE: AdvanceResult = { kind: 'done' }

/**
 * Scripted ExecutionService + instant sleep that record their interleaving, so the
 * tests can assert the poll/sleep ORDER (the point of the poll-first change), not just
 * call counts.
 */
function harness(script: {
  /** A queued `Error` is THROWN by `advanceInstance` (a step that raised), not returned. */
  advance: (AdvanceResult | Error)[]
  /** A queued `Error` is THROWN by the poll (a status read that failed), not returned. */
  pollJob?: (AdvanceResult | Error)[]
  pollGate?: AdvanceResult[]
}) {
  const events: string[] = []
  const shift = (queue: (AdvanceResult | Error)[] | undefined, label: string): AdvanceResult => {
    const next = queue?.shift()
    if (!next) throw new Error(`unexpected ${label} call`)
    if (next instanceof Error) throw next
    return next
  }
  const exec = {
    advanceInstance: async () => {
      events.push('advance')
      return shift(script.advance, 'advance')
    },
    pollAgentJob: async () => {
      events.push('pollJob')
      return shift(script.pollJob, 'pollJob')
    },
    pollGate: async () => {
      events.push('pollGate')
      return shift(script.pollGate, 'pollGate')
    },
    resolveGatePollExhaustion: async () => {
      events.push('gateExhausted')
      return DONE
    },
    failRun: async (
      _ws: string,
      _id: string,
      message: string,
      kind: string,
      _detail: string | null,
      reason: string | null,
    ) => {
      events.push(`fail:${kind}:${message}${reason ? `:reason=${reason}` : ''}`)
    },
  } as unknown as Exec
  const sleep = async (ms: number) => {
    events.push(`sleep:${ms}`)
  }
  return { exec, events, sleep }
}

describe('driveExecution poll cadence', () => {
  it('polls a dispatched job BEFORE the first sleep (no leading dead air)', async () => {
    const h = harness({ advance: [AWAITING_JOB], pollJob: [DONE] })
    await driveExecution(h.exec, 'ws', 'ex', CFG, { sleep: h.sleep })
    // A job that settles on the first poll never sleeps at all — previously the driver
    // slept a full jobPollIntervalMs (default 15s) before even looking.
    expect(h.events).toEqual(['advance', 'pollJob'])
  })

  it('sleeps a full interval between job polls after the first', async () => {
    const h = harness({ advance: [AWAITING_JOB], pollJob: [AWAITING_JOB, DONE] })
    await driveExecution(h.exec, 'ws', 'ex', CFG, { sleep: h.sleep })
    expect(h.events).toEqual(['advance', 'pollJob', 'sleep:15000', 'pollJob'])
  })

  it('keeps gate polls sleep-first (the precheck just ran inside advance)', async () => {
    const h = harness({ advance: [AWAITING_GATE], pollGate: [DONE] })
    await driveExecution(h.exec, 'ws', 'ex', CFG, { sleep: h.sleep })
    expect(h.events).toEqual(['advance', 'sleep:30000', 'pollGate'])
  })

  it('spends the full job poll budget (maxPolls polls, maxPolls-1 sleeps) then times out', async () => {
    const h = harness({
      advance: [AWAITING_JOB],
      pollJob: Array.from({ length: CFG.jobMaxPolls }, () => AWAITING_JOB),
    })
    await driveExecution(h.exec, 'ws', 'ex', CFG, { sleep: h.sleep })
    expect(h.events.filter((e) => e === 'pollJob')).toHaveLength(CFG.jobMaxPolls)
    expect(h.events.filter((e) => e.startsWith('sleep:'))).toHaveLength(CFG.jobMaxPolls - 1)
    expect(h.events.at(-1)).toBe(
      'fail:timeout:Implementation job did not settle within its polling budget',
    )
  })
})

describe('driveExecution poll-failure cause recovery', () => {
  it('carries the last read error into the terminal message and warns per attempt', async () => {
    // A bare `catch` used to discard the cause entirely: the run died as "status was
    // unreadable (3 polls)" with the actual reason (DNS, TLS, a 502) existing nowhere on
    // Node/local, while the Cloudflare twin had always appended it.
    const log = createRecordingLogger()
    const h = harness({
      advance: [AWAITING_JOB],
      pollJob: [new Error('fetch failed: ECONNREFUSED'), new Error('502'), new Error('502')],
    })
    await driveExecution(h.exec, 'ws', 'ex', CFG, { sleep: h.sleep, log })

    expect(h.events.at(-1)).toBe(
      'fail:timeout:Implementation job status was unreadable (3 polls) (last error: 502)',
    )
    const warnings = log.lines.filter((l) => l.level === 'warn')
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toMatchObject({
      msg: 'run poll failed',
      // The run's ids are bound once via `child`, so every driver line is greppable by run.
      fields: {
        workspaceId: 'ws',
        executionId: 'ex',
        readFailures: 1,
        err: 'fetch failed: ECONNREFUSED',
      },
    })
  })

  it('clears the remembered cause once a poll succeeds', async () => {
    // Otherwise a run that recovered mid-poll and later timed out for an unrelated reason
    // would be blamed on a transient read failure minutes earlier.
    const h = harness({
      advance: [AWAITING_JOB],
      pollJob: [new Error('transient'), AWAITING_JOB, AWAITING_JOB, AWAITING_JOB, AWAITING_JOB],
    })
    await driveExecution(h.exec, 'ws', 'ex', CFG, { sleep: h.sleep })
    expect(h.events.at(-1)).toBe(
      'fail:timeout:Implementation job did not settle within its polling budget',
    )
  })
})

describe('driveExecution failure identity', () => {
  it('lifts a thrown DomainError’s details.reason onto the run failure, as a preflight', async () => {
    // The step-result path has always forwarded `reason`; the advance-THROW path dropped it,
    // so the one failure class the SPA can offer a remedy for arrived as prose with no
    // machine-readable code (observability-logging-gaps.md, B3). `getErrorReason` is the
    // read-side dual of the `reason` a `ConflictError` carries.
    //
    // The KIND is `preflight`, matching what `classifyDispatchFailure` records for the same
    // refusal caught one layer deeper: a precondition the run never satisfied means nothing
    // reached an agent, and `agent` sends a reader looking for a transcript that does not exist.
    const h = harness({
      advance: [
        new ConflictError('No configured provider for this model.', 'providers_unconfigured'),
      ],
    })
    await driveExecution(h.exec, 'ws', 'ex', CFG, { sleep: h.sleep })
    expect(h.events.at(-1)).toBe(
      'fail:preflight:No configured provider for this model.:reason=providers_unconfigured',
    )
  })

  it('leaves the reason unset — and the kind `agent` — for a plain Error', async () => {
    // Only a DomainError is evidence of a precondition; anything else stays the agent's failure.
    const h = harness({ advance: [new Error('the container exploded')] })
    await driveExecution(h.exec, 'ws', 'ex', CFG, { sleep: h.sleep })
    expect(h.events.at(-1)).toBe('fail:agent:the container exploded')
  })
})

describe('driveExecution step ceiling', () => {
  /** An `ExecutionService` whose advance never settles, the wedged HTTP call F9 is about. */
  function hangingExec(events: string[]): Exec {
    return {
      advanceInstance: () => {
        events.push('advance')
        return new Promise<AdvanceResult>(() => {})
      },
      pollAgentJob: async () => {
        events.push('pollJob')
        return DONE
      },
      failRun: async (_ws: string, _id: string, message: string, kind: string) => {
        events.push(`fail:${kind}:${message}`)
      },
    } as unknown as Exec
  }

  it('fails a wedged advance at the ceiling instead of waiting on it forever', async () => {
    // pg-boss heartbeats an ACTIVE job regardless of handler progress, so the sweeper reads a
    // hung advance as `live` and skips it: without this bound the run sits until the queue's
    // expire cap (up to 24h). Cloudflare has always capped the same call at its `step.do`
    // timeout.
    const events: string[] = []
    const log = createRecordingLogger()
    await driveExecution(
      hangingExec(events),
      'ws',
      'ex',
      { ...CFG, advanceTimeoutMs: 300_000 },
      {
        sleep: async () => {},
        log,
        // The facade's clock, stubbed to expire at once: what is under test is the driver's
        // reaction to the ceiling, not the timer that measures it.
        withStepCeiling: async () => ({ timedOut: true }),
      },
    )

    // `timeout`, not the `agent` kind a thrown advance records: nothing reached an agent.
    expect(events).toEqual([
      'advance',
      'fail:timeout:Step advance did not complete within 5 minutes',
    ])
    expect(log.lines.filter((l) => l.level === 'warn')).toMatchObject([
      { msg: 'advance exceeded its ceiling; failing the run', fields: { ceilingMs: 300_000 } },
    ])
  })

  it('never consults the facade clock when the ceiling is disabled', async () => {
    // `advanceTimeoutMs: 0` is the conformance/unit opt-out. A facade wires its real clock
    // unconditionally, so the opt-out has to win HERE, or a zero-length ceiling would
    // fail every advance on the first tick.
    const events: string[] = []
    const h = harness({ advance: [DONE] })
    await driveExecution(
      h.exec,
      'ws',
      'ex',
      { ...CFG, advanceTimeoutMs: 0 },
      {
        sleep: h.sleep,
        withStepCeiling: async () => {
          events.push('ceiling')
          return { timedOut: true }
        },
      },
    )

    expect(events).toEqual([])
    expect(h.events).toEqual(['advance'])
  })
})

describe('driveExecution poll ceiling', () => {
  it('counts a status read that never answers as one unreadable poll, not a failed run', async () => {
    // The Worker runs every poll inside a `step.do` carrying the SAME `stepConfig` as an advance,
    // and a timed-out step throws into `pollOnce`, which tolerates a bounded run of them. Node
    // bounded the advance and left the polls unbounded, so a hung status read wedged the run in
    // exactly the way F9 describes: pg-boss keeps heartbeating the active job, so the stale-run
    // sweeper still reads it `live` and skips it.
    const events: string[] = []
    const exec = {
      advanceInstance: async () => {
        events.push('advance')
        return AWAITING_JOB
      },
      pollAgentJob: () => {
        events.push('pollJob')
        return new Promise<AdvanceResult>(() => {})
      },
      failRun: async (_ws: string, _id: string, message: string, kind: string) => {
        events.push(`fail:${kind}:${message}`)
      },
    } as unknown as Exec

    // The advance settles; every poll after it hangs. Asserting on the DRIVER's reaction, not on
    // the timer that measures it — the facade wrapper owns the clock.
    let calls = 0
    await driveExecution(
      exec,
      'ws',
      'ex',
      { ...CFG, advanceTimeoutMs: 300_000, jobPollFailureTolerance: 2 },
      {
        sleep: async () => {},
        withStepCeiling: async (work) =>
          ++calls === 1 ? { timedOut: false, value: await work } : { timedOut: true },
      },
    )

    // Tolerated, then terminal once the tolerance is spent — never on the first unanswered read.
    expect(events.slice(0, 3)).toEqual(['advance', 'pollJob', 'pollJob'])
    expect(events.at(-1)).toContain(
      'fail:timeout:Implementation job status was unreadable (2 polls)',
    )
    expect(events.at(-1)).toContain('no answer within 5 minutes')
  })
})

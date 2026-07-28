import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
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
  advance: AdvanceResult[]
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
    failRun: async (_ws: string, _id: string, message: string, kind: string) => {
      events.push(`fail:${kind}:${message}`)
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

import { describe, expect, it } from 'vitest'
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
  pollJob?: AdvanceResult[]
  pollGate?: AdvanceResult[]
}) {
  const events: string[] = []
  const shift = (queue: AdvanceResult[] | undefined, label: string): AdvanceResult => {
    const next = queue?.shift()
    if (!next) throw new Error(`unexpected ${label} call`)
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

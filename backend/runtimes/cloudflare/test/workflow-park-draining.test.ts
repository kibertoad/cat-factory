import { describe, expect, it } from 'vitest'
import type { AdvanceResult, RunFailure } from '@cat-factory/orchestration'
import {
  drainParks,
  type GatePollLoopDeps,
  type PollAttempt,
  type PollLoopDeps,
} from '../src/infrastructure/workflows/parkDraining'

// The Worker driver's park-draining loop. Two properties, both of which the flat branch sequence
// this replaced got wrong, and neither of which any other guard can see:
//
//   1. A park raised by a poll is DRAINED, whatever raised it. Draining is not a fixed sequence of
//      one-shot branches: a deploy job settling into an environment that is still building raises
//      `awaiting_environment` from INSIDE the job loop, and a flat sequence that had already
//      passed its environment branch matched nothing and re-advanced, standing a second
//      environment up for the same frame. `drive.ts` on the Node side has always looped here.
//   2. Every durable step NAME is used at most once. Workflows memoises by name, so a reused name
//      does not fail loudly: the second use replays the first's recorded answer and issues no poll
//      of its own. That is silent, and it is why each hop carries its own name scope.

/** A fake `WorkflowStep`: records every durable name it is asked for, and never really sleeps. */
function recordingStep(names: string[]) {
  return {
    sleep: async (name: string) => {
      names.push(name)
    },
    do: async (name: string, _config: unknown, body: () => Promise<unknown>) => {
      names.push(name)
      return body()
    },
  }
}

/**
 * Deps whose `poll` answers from `answers` in order (the last entry repeats), routed through the
 * same `pollOnce` wrapper the real driver injects so the durable step names it mints are the real
 * ones. `failures` collects what the loop decided to fail the run with.
 */
function deps(answers: AdvanceResult[]) {
  const names: string[] = []
  const failures: RunFailure[] = []
  let polls = 0
  const step = recordingStep(names)
  const job = {
    step,
    log: { warn: () => undefined },
    maxPolls: 8,
    failureTolerance: 3,
    pollInterval: '1 second',
    stepConfig: {},
    pollOnce: async (label: string, read: () => Promise<AdvanceResult>): Promise<PollAttempt> => ({
      kind: 'ok',
      result: (await step.do(label, {}, read)) as AdvanceResult,
    }),
    failRun: async (_i: number, failure: RunFailure) => {
      failures.push(failure)
    },
    poll: async () => answers[Math.min(polls++, answers.length - 1)]!,
  } as unknown as PollLoopDeps
  const gate = {
    ...job,
    resolveExhaustion: async () => answers.at(-1)!,
  } as unknown as GatePollLoopDeps
  return { bundle: { job, gate }, names, failures, pollCount: () => polls }
}

describe("Worker driver: draining a step's parks", () => {
  it('drains an environment park raised by the JOB poll instead of re-advancing on it', async () => {
    // The reported run's exact shape: a container-backed deploy job finishes, its provider is
    // still building, and the engine parks the step again on `awaiting_environment`.
    const d = deps([
      { kind: 'awaiting_environment', stepIndex: 0 },
      { kind: 'continue' },
    ] as AdvanceResult[])

    const result = await drainParks(d.bundle, 0, {
      kind: 'awaiting_job',
      jobId: 'job-1',
      stepIndex: 0,
    })

    // Not `awaiting_environment`: had the loop handed that back, the driver would have re-advanced
    // and `runDeployerStep` would have provisioned the frame a second time.
    expect(result).toEqual({ kind: 'continue' })
  })

  it('drains a job park raised by a GATE poll, so branch order cannot matter', async () => {
    // A `ci` gate finding CI red dispatches a `ci-fixer` and returns `awaiting_job` — raised by a
    // branch the flat sequence had already passed.
    const d = deps([
      { kind: 'awaiting_job', jobId: 'fixer-1', stepIndex: 0 },
      { kind: 'continue' },
    ] as AdvanceResult[])

    const result = await drainParks(d.bundle, 0, { kind: 'awaiting_gate', stepIndex: 0 })

    expect(result).toEqual({ kind: 'continue' })
  })

  it('mints a distinct durable step name for every poll it issues', async () => {
    const d = deps([
      { kind: 'awaiting_environment', stepIndex: 0 },
      { kind: 'continue' },
    ] as AdvanceResult[])

    await drainParks(d.bundle, 0, { kind: 'awaiting_job', jobId: 'job-1', stepIndex: 0 })

    // The property, not a pinned list: a repeat here is a poll that never ran, because Workflows
    // would have served it the earlier step's memoised answer.
    expect(new Set(d.names).size).toBe(d.names.length)
    // And it really did poll on both hops rather than replaying one.
    expect(d.pollCount()).toBe(2)
  })

  it('hands back a re-armed gate rather than hopping again on it', async () => {
    // An unbounded-wait gate (human review) re-arms from `resolveGatePollExhaustion`. Looping in
    // place would spend a fresh poll budget of durable sleeps per hop for a wait lasting days.
    const d = deps([{ kind: 'awaiting_gate', stepIndex: 0 }] as AdvanceResult[])

    const result = await drainParks(d.bundle, 0, { kind: 'awaiting_gate', stepIndex: 0 })

    expect(result).toMatchObject({ kind: 'awaiting_gate' })
    expect(d.failures).toEqual([])
  })

  it('returns null once a loop has already failed the run', async () => {
    // Every answer stays parked, so the job loop spends its budget and records the failure. The
    // driver must stop rather than act on a result nothing settled.
    const d = deps([{ kind: 'awaiting_job', jobId: 'job-1', stepIndex: 0 }] as AdvanceResult[])

    const result = await drainParks(d.bundle, 0, {
      kind: 'awaiting_job',
      jobId: 'job-1',
      stepIndex: 0,
    })

    expect(result).toBeNull()
    expect(d.failures).toHaveLength(1)
  })
})

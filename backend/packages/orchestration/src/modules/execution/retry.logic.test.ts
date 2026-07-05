import { describe, expect, it } from 'vitest'
import type { AgentFailure, AgentKind, PipelineStep } from '@cat-factory/kernel'
import {
  carryForwardFailures,
  carryForwardOutputs,
  MAX_FAILURE_HISTORY,
  MAX_HISTORY_OUTPUT_CHARS,
  MAX_OUTPUT_HISTORY,
  planResumedSteps,
  planRestartFromStep,
} from './retry.logic.js'

const step = (
  agentKind: AgentKind,
  state: PipelineStep['state'],
  extra: Partial<PipelineStep> = {},
): PipelineStep => ({
  agentKind,
  state,
  progress: state === 'done' ? 1 : 0,
  decision: null,
  ...extra,
})

// `pl_full`'s shape: the coder sits behind two human-gated steps.
const fullSteps = (coderState: PipelineStep['state']): PipelineStep[] => [
  step('requirements-review', 'done', {
    requiresApproval: true,
    approval: { id: 'a1', status: 'approved', proposal: 'reqs' },
    output: 'requirements output',
    startedAt: 1,
    finishedAt: 2,
  }),
  step('architect', 'done', {
    requiresApproval: true,
    approval: { id: 'a2', status: 'approved', proposal: 'design' },
    output: 'architect output',
    startedAt: 3,
    finishedAt: 4,
  }),
  step('researcher', 'done', { output: 'research', startedAt: 5, finishedAt: 6 }),
  step('coder', coderState, {
    jobId: 'job-123',
    subtasks: { completed: 2, inProgress: 1, total: 8, items: [] },
    output: 'partial',
    startedAt: 7,
  }),
  step('tester-api', 'pending'),
  step('merger', 'pending'),
]

describe('planResumedSteps', () => {
  it('resumes from the failed step, preserving the completed steps before it', () => {
    // The coder failed (eviction) while still `working`; the gates before it are done.
    const { steps, currentStep } = planResumedSteps({ steps: fullSteps('working'), currentStep: 3 })

    expect(currentStep).toBe(3)
    // The two gated steps + researcher are untouched (no re-run, approvals kept).
    expect(steps.slice(0, 3).map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(steps[0]!.approval?.status).toBe('approved')
    expect(steps[1]!.output).toBe('architect output')
  })

  it('resets the failed step to a clean working state, dropping transient run state', () => {
    const { steps } = planResumedSteps({ steps: fullSteps('working'), currentStep: 3 })

    const coder = steps[3]!
    expect(coder.state).toBe('working')
    expect(coder.agentKind).toBe('coder')
    expect(coder.jobId).toBeUndefined()
    expect(coder.subtasks).toBeUndefined()
    expect(coder.output).toBeUndefined()
    expect(coder.progress).toBe(0)
    expect(coder.startedAt).toBeUndefined() // re-stamped fresh by startStep on advance
  })

  it('leaves the steps after the failed one pending', () => {
    const { steps } = planResumedSteps({ steps: fullSteps('working'), currentStep: 3 })
    expect(steps.slice(4).map((s) => s.state)).toEqual(['pending', 'pending'])
  })

  it('preserves the approval gate flag on the resumed step so it re-gates after the re-run', () => {
    const gated = [
      step('architect', 'working', { requiresApproval: true, jobId: 'j', output: 'x' }),
      step('coder', 'pending'),
    ]
    const { steps } = planResumedSteps({ steps: gated, currentStep: 0 })
    expect(steps[0]!.requiresApproval).toBe(true)
    expect(steps[0]!.approval).toBeNull()
    expect(steps[0]!.state).toBe('working')
  })

  it('derives the resume point from the step states even if currentStep is stale', () => {
    // currentStep wrongly points past the real first-unfinished step.
    const { currentStep } = planResumedSteps({ steps: fullSteps('working'), currentStep: 5 })
    expect(currentStep).toBe(3)
  })

  it('re-runs the last step when every step is somehow done (defensive no-op guard)', () => {
    const allDone = [step('coder', 'done'), step('merger', 'done')]
    const { steps, currentStep } = planResumedSteps({ steps: allDone, currentStep: 1 })
    expect(currentStep).toBe(1)
    expect(steps[1]!.state).toBe('working')
    expect(steps[0]!.state).toBe('done')
  })
})

describe('planRestartFromStep', () => {
  it('rewinds a fully-done run to an arbitrary chosen step', () => {
    // Every step completed; the human picks to restart from the architect (index 1).
    const allDone = fullSteps('done')
    const { steps, currentStep } = planRestartFromStep({ steps: allDone }, 1)

    expect(currentStep).toBe(1)
    // The requirements step before it is preserved verbatim (handoff context).
    expect(steps[0]!.state).toBe('done')
    expect(steps[0]!.output).toBe('requirements output')
    expect(steps[0]!.approval?.status).toBe('approved')
    // The chosen step re-runs; everything after it is reset to pending.
    expect(steps[1]!.state).toBe('working')
    expect(steps[1]!.output).toBeUndefined()
    expect(steps.slice(2).map((s) => s.state)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('drops the chosen step iteration/transient state so its loops restart from zero', () => {
    const withCounters = [
      step('architect', 'done', { output: 'a', startedAt: 1, finishedAt: 2 }),
      step('coder', 'done', {
        jobId: 'j',
        output: 'code',
        subtasks: { completed: 8, inProgress: 0, total: 8, items: [] },
        startedAt: 3,
        finishedAt: 4,
      }),
    ]
    const { steps } = planRestartFromStep({ steps: withCounters }, 1)
    const coder = steps[1]!
    expect(coder.state).toBe('working')
    expect(coder.jobId).toBeUndefined()
    expect(coder.subtasks).toBeUndefined()
    expect(coder.output).toBeUndefined()
    expect(coder.startedAt).toBeUndefined()
    expect(coder.progress).toBe(0)
  })

  it('restarting from step 0 resets the whole run, preserving nothing', () => {
    const { steps, currentStep } = planRestartFromStep({ steps: fullSteps('done') }, 0)
    expect(currentStep).toBe(0)
    expect(steps[0]!.state).toBe('working')
    expect(steps.slice(1).every((s) => s.state === 'pending')).toBe(true)
  })

  it('clamps an out-of-range index into the step range (the service rejects it first)', () => {
    const { currentStep } = planRestartFromStep({ steps: fullSteps('done') }, 99)
    expect(currentStep).toBe(5) // last step
  })
})

describe('carryForwardFailures', () => {
  const failure = (message: string, occurredAt: number): AgentFailure => ({
    kind: 'agent',
    message,
    detail: null,
    hint: null,
    occurredAt,
    lastSubtasks: null,
  })

  it('appends the outgoing failure to the prior trail, oldest→newest', () => {
    const first = failure('first crash', 1)
    const second = failure('second crash', 2)
    const trail = carryForwardFailures({ failure: second, failureHistory: [first] })
    expect(trail).toEqual([first, second])
  })

  it('seeds the trail from a first failure when there was no prior history', () => {
    const only = failure('boom', 1)
    expect(carryForwardFailures({ failure: only })).toEqual([only])
  })

  it('keeps the existing trail unchanged when the outgoing run has no failure', () => {
    // A restart of a still-running / already-succeeded run carries the trail through untouched.
    const prior = [failure('older', 1)]
    expect(carryForwardFailures({ failure: null, failureHistory: prior })).toEqual(prior)
    expect(carryForwardFailures({ failureHistory: prior })).toEqual(prior)
  })

  it('returns an empty trail when there is neither a failure nor a history', () => {
    expect(carryForwardFailures({})).toEqual([])
  })

  it('accumulates across repeated retries', () => {
    const a = failure('a', 1)
    const b = failure('b', 2)
    const c = failure('c', 3)
    // retry #1: failed run (a) → trail [a]
    const afterFirst = carryForwardFailures({ failure: a })
    // retry #2: the run failed again (b) carrying [a] → trail [a, b]
    const afterSecond = carryForwardFailures({ failure: b, failureHistory: afterFirst })
    // retry #3: failed again (c) → [a, b, c]
    const afterThird = carryForwardFailures({ failure: c, failureHistory: afterSecond })
    expect(afterThird).toEqual([a, b, c])
  })

  it('caps the trail at MAX_FAILURE_HISTORY, dropping the oldest', () => {
    // A run that flapped past the cap: a full history plus one more outgoing failure.
    const full = Array.from({ length: MAX_FAILURE_HISTORY }, (_, i) => failure(`old ${i}`, i))
    const newest = failure('newest', MAX_FAILURE_HISTORY)
    const trail = carryForwardFailures({ failure: newest, failureHistory: full })
    expect(trail).toHaveLength(MAX_FAILURE_HISTORY)
    // The oldest is evicted; the newest is retained at the tail.
    expect(trail[0]).toEqual(full[1])
    expect(trail.at(-1)).toEqual(newest)
  })
})

describe('carryForwardOutputs', () => {
  it('records the successful outputs a restart discards, attributed to their step', () => {
    // A fully-done run restarted from the architect (index 1): the architect + researcher +
    // coder outputs are about to be dropped, so they're preserved with their step index.
    const { steps, currentStep } = planRestartFromStep({ steps: fullSteps('done') }, 1)
    const trail = carryForwardOutputs({ steps: fullSteps('done') }, currentStep, 999)
    expect(currentStep).toBe(1)
    // The preserved-before-the-restart step 0 is NOT recorded (it keeps its output on the step).
    expect(trail.map((o) => o.stepIndex)).toEqual([1, 2, 3])
    expect(trail[0]).toMatchObject({ stepIndex: 1, output: 'architect output', occurredAt: 4 })
    // Sanity: the plan really did reset those steps' outputs (so the history is the only copy).
    expect(steps[1]!.output).toBeUndefined()
  })

  it('records nothing for a retry (it resumes at the first UNFINISHED step)', () => {
    // A retry resumes at the failed coder (index 3); no completed step is reset, so there is
    // no successful output to preserve — the trail is just carried through untouched.
    const { currentStep } = planResumedSteps({ steps: fullSteps('working'), currentStep: 3 })
    const prior = [{ stepIndex: 0, occurredAt: 1, output: 'earlier restart' }]
    expect(
      carryForwardOutputs({ steps: fullSteps('working'), outputHistory: prior }, currentStep, 9),
    ).toEqual(prior)
  })

  it('skips reset steps with no usable output (failed / never-run / whitespace-only)', () => {
    const steps: PipelineStep[] = [
      step('coder', 'done', { output: '   ', finishedAt: 2 }), // whitespace-only → skipped
      step('tester-api', 'working', { output: 'partial', finishedAt: 3 }), // not done → skipped
      step('merger', 'pending'), // never ran → skipped
    ]
    expect(carryForwardOutputs({ steps }, 0, 100)).toEqual([])
  })

  it('accumulates across successive restarts, oldest→newest', () => {
    const prior = [{ stepIndex: 1, occurredAt: 4, output: 'from an earlier restart' }]
    const steps: PipelineStep[] = [step('spec-writer', 'done', { output: 'spec', finishedAt: 10 })]
    const trail = carryForwardOutputs({ steps, outputHistory: prior }, 0, 50)
    expect(trail).toEqual([prior[0], { stepIndex: 0, occurredAt: 10, output: 'spec' }])
  })

  it('falls back to the supplied clock when a discarded step has no finishedAt', () => {
    const steps: PipelineStep[] = [step('coder', 'done', { output: 'code' })]
    expect(carryForwardOutputs({ steps }, 0, 777)).toEqual([
      { stepIndex: 0, occurredAt: 777, output: 'code' },
    ])
  })

  it('clips an oversized output and flags it truncated', () => {
    const big = 'x'.repeat(MAX_HISTORY_OUTPUT_CHARS + 500)
    const steps: PipelineStep[] = [step('architect', 'done', { output: big, finishedAt: 1 })]
    const [entry] = carryForwardOutputs({ steps }, 0, 1)
    expect(entry!.output).toHaveLength(MAX_HISTORY_OUTPUT_CHARS)
    expect(entry!.truncated).toBe(true)
  })

  it('caps the trail at MAX_OUTPUT_HISTORY, dropping the oldest', () => {
    const prior = Array.from({ length: MAX_OUTPUT_HISTORY }, (_, i) => ({
      stepIndex: 0,
      occurredAt: i,
      output: `old ${i}`,
    }))
    const steps: PipelineStep[] = [step('coder', 'done', { output: 'newest', finishedAt: 999 })]
    const trail = carryForwardOutputs({ steps, outputHistory: prior }, 0, 1)
    expect(trail).toHaveLength(MAX_OUTPUT_HISTORY)
    expect(trail[0]).toEqual(prior[1]) // oldest evicted
    expect(trail.at(-1)).toMatchObject({ output: 'newest' })
  })
})

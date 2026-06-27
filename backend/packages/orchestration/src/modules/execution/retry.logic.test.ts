import { describe, expect, it } from 'vitest'
import type { AgentKind, PipelineStep } from '@cat-factory/kernel'
import { planResumedSteps, planRestartFromStep } from './retry.logic.js'

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

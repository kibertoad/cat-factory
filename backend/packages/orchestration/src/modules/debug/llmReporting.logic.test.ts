import type { ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { llmReportingGaps } from './llmReporting.logic.js'

// What a run's model-activity totals DO NOT cover. The whole reason this fold exists is that
// absence in a NUMBER is invisible: a run whose implementing step ran on somebody else's CI reports
// a small, complete-looking total, and a person, a cost dashboard and a model asked why the task was
// cheap all read it the same wrong way.

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'coder', state: 'done', progress: 1, ...overrides } as PipelineStep
}

function delegated(executor: string, overrides: Partial<PipelineStep> = {}): PipelineStep {
  return step({
    agentKind: 'acme:impl',
    delegated: {
      executor,
      status: 'done',
      correlationKey: 'k',
      poll: { intervalMs: 1000, maxDurationMs: 10_000 },
      attempts: [{ startedAt: 0 }],
    },
    ...overrides,
  })
}

const run = (steps: PipelineStep[]) => ({ steps }) as Pick<ExecutionInstance, 'steps'>

describe('llmReportingGaps', () => {
  it('answers a REAL zero for a run that delegated nothing', () => {
    // Zero is an answer here, which is exactly why the field is always present: an absent
    // `reporting` and a zero count are the same JSON value and opposite facts.
    expect(llmReportingGaps(run([step(), step({ agentKind: 'merger' })]))).toEqual({
      delegatedStepsWithoutUsage: 0,
      executors: [],
    })
  })

  it('counts a delegated step whose spend never reached this platform, and NAMES the executor', () => {
    expect(llmReportingGaps(run([step(), delegated('acme:executor')]))).toEqual({
      delegatedStepsWithoutUsage: 1,
      executors: ['acme:executor'],
    })
  })

  it('deduplicates the executors while still counting every step', () => {
    const gaps = llmReportingGaps(
      run([delegated('acme:executor'), delegated('acme:executor'), delegated('other:executor')]),
    )
    expect(gaps.delegatedStepsWithoutUsage).toBe(3)
    expect(gaps.executors).toEqual(['acme:executor', 'other:executor'])
  })

  it('reads what LANDED, not what the executor DECLARED', () => {
    // An executor that declares `self-reported` and silently stops filing is precisely the case a
    // declaration-based check would report as covered, so the fold asks the step's own metrics.
    const filed = delegated('acme:executor', {
      metrics: { calls: 3 } as PipelineStep['metrics'],
    })
    expect(llmReportingGaps(run([filed]))).toEqual({
      delegatedStepsWithoutUsage: 0,
      executors: [],
    })
  })

  it('treats a metrics block with no calls in it as nothing reported', () => {
    const empty = delegated('acme:executor', { metrics: { calls: 0 } as PipelineStep['metrics'] })
    expect(llmReportingGaps(run([empty])).delegatedStepsWithoutUsage).toBe(1)
  })

  it('answers for a run it could not read at all', () => {
    // The debug export joins the run into its wave; a run that vanished under it must not take the
    // whole document down, and "no gaps known" is the only honest thing left to say.
    expect(llmReportingGaps(null)).toEqual({ delegatedStepsWithoutUsage: 0, executors: [] })
  })
})

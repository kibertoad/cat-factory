import type { ExecutionInstance, PipelineStep } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { buildRunTraceSpans } from './runTraceSpans.logic.js'

// The fold that turns a settled run into the PARENTS of the spans it already exported. What is
// pinned here is what a reader of the resulting trace would otherwise be misled about: which
// step failed, how many steps a span covers, and whether a step ran at all.

function step(overrides: Partial<PipelineStep>): PipelineStep {
  return {
    agentKind: 'coder',
    state: 'done',
    progress: 1,
    startedAt: 1_000,
    finishedAt: 2_000,
    ...overrides,
  } as PipelineStep
}

function instance(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_bugfix',
    pipelineName: 'Bugfix',
    steps: [step({})],
    currentStep: 0,
    status: 'done',
    createdAt: 500,
    ...overrides,
  } as ExecutionInstance
}

describe('buildRunTraceSpans', () => {
  it('builds a root span over the run and one span per agent kind that ran', () => {
    const spans = buildRunTraceSpans(
      'ws_1',
      instance({
        steps: [
          step({ agentKind: 'architect', startedAt: 1_000, finishedAt: 1_500 }),
          step({ agentKind: 'coder', startedAt: 1_600, finishedAt: 4_000 }),
        ],
      }),
      9_000,
    )!

    expect(spans.run).toEqual({
      workspaceId: 'ws_1',
      executionId: 'exec_1',
      pipelineName: 'Bugfix',
      startedAt: 500,
      endedAt: 9_000,
      ok: true,
      errorMessage: null,
    })
    expect(spans.steps.map((s) => [s.agentKind, s.startedAt, s.endedAt, s.stepCount])).toEqual([
      ['architect', 1_000, 1_500, 1],
      ['coder', 1_600, 4_000, 1],
    ])
  })

  it('folds repeated steps of one kind into a single span that STATES the count', () => {
    // Two `coder` steps is the case a per-index parent would have handled and this grain cannot:
    // the span covers both, so it has to say so or it reads as one step that took 3s.
    const spans = buildRunTraceSpans(
      'ws_1',
      instance({
        steps: [
          step({ agentKind: 'coder', startedAt: 1_000, finishedAt: 2_000 }),
          step({ agentKind: 'reviewer', startedAt: 2_000, finishedAt: 2_500 }),
          step({ agentKind: 'coder', startedAt: 3_000, finishedAt: 4_000 }),
        ],
      }),
      5_000,
    )!

    const coder = spans.steps.find((s) => s.agentKind === 'coder')!
    expect(coder.stepCount).toBe(2)
    expect([coder.startedAt, coder.endedAt]).toEqual([1_000, 4_000])
    expect(spans.steps.find((s) => s.agentKind === 'reviewer')!.stepCount).toBe(1)
  })

  it('marks ONLY the step the run failed on as errored', () => {
    const spans = buildRunTraceSpans(
      'ws_1',
      instance({
        status: 'failed',
        failure: {
          kind: 'agent',
          message: 'container died',
          detail: null,
          hint: null,
          occurredAt: 4_000,
          lastSubtasks: null,
          stepIndex: 1,
        },
        steps: [
          step({ agentKind: 'architect', startedAt: 1_000, finishedAt: 1_500 }),
          step({ agentKind: 'coder', startedAt: 1_600, finishedAt: null }),
        ],
      }),
      5_000,
    )!

    expect(spans.run.ok).toBe(false)
    expect(spans.run.errorMessage).toBe('container died')
    // The architect genuinely succeeded; painting the whole run red would say otherwise.
    expect(spans.steps.map((s) => [s.agentKind, s.ok, s.errorMessage])).toEqual([
      ['architect', true, null],
      ['coder', false, 'container died'],
    ])
    // An unfinished step's span closes at the run's settle time rather than running open.
    expect(spans.steps[1]!.endedAt).toBe(5_000)
  })

  it('gives a step that never started no span at all', () => {
    // An estimate-gated (skipped) step contributed no telemetry. A zero-width span for it would
    // show an operator a step that was deliberately not run.
    const spans = buildRunTraceSpans(
      'ws_1',
      instance({
        steps: [
          step({ agentKind: 'coder' }),
          step({ agentKind: 'human-review', startedAt: null, finishedAt: null }),
        ],
      }),
      5_000,
    )!

    expect(spans.steps.map((s) => s.agentKind)).toEqual(['coder'])
  })

  it('falls back to the earliest step start when the run carries no creation time', () => {
    const spans = buildRunTraceSpans(
      'ws_1',
      instance({ createdAt: undefined, steps: [step({ startedAt: 1_234 })] }),
      5_000,
    )!

    expect(spans.run.startedAt).toBe(1_234)
  })

  it('returns null for a run with no observable extent', () => {
    // Never stamped, never started a step: it emitted no children, so there is nothing to
    // parent and an empty trace would be worse than none.
    expect(
      buildRunTraceSpans(
        'ws_1',
        instance({ createdAt: undefined, steps: [step({ startedAt: null, finishedAt: null })] }),
        5_000,
      ),
    ).toBeNull()
  })

  it('clamps a settle time that precedes the run start', () => {
    const spans = buildRunTraceSpans('ws_1', instance({ createdAt: 9_000 }), 1_000)!
    expect(spans.run.endedAt).toBe(9_000)
  })
})

import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { projectExecutionForBoard, stepHasOutput } from './board-projection.js'
import { executionInstanceSchema, type ExecutionInstance } from './execution.js'

// The board snapshot's lean execution projection. Two properties matter and neither is
// obvious from reading the function: the result must still be a VALID `ExecutionInstance`
// (the SPA re-validates the whole snapshot, so a projection that trips the schema bricks the
// board load rather than shrinking it), and every withheld field must stay DISTINGUISHABLE
// from a genuinely absent one.

function run(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_default',
    pipelineName: 'Default',
    currentStep: 0,
    status: 'running',
    steps: [
      {
        agentKind: 'coder',
        state: 'done',
        progress: 100,
        decision: null,
        output: 'a long prose answer',
      },
      { agentKind: 'tester', state: 'pending', progress: 0, decision: null },
    ],
    ...overrides,
  } as ExecutionInstance
}

describe('projectExecutionForBoard', () => {
  it('withholds the captured text the board never renders', () => {
    const projected = projectExecutionForBoard(
      run({
        outputHistory: [
          { stepIndex: 0, agentKind: 'coder', output: 'superseded', truncated: false },
        ],
        steps: [
          {
            agentKind: 'coder',
            state: 'done',
            progress: 100,
            decision: null,
            output: 'prose',
            rework: { previousProposal: 'old', notes: [] },
            testerQuality: { verdicts: [] },
          },
        ],
      } as unknown as Partial<ExecutionInstance>),
    )
    expect(projected.outputHistory).toBeUndefined()
    expect(projected.steps[0]!.output).toBeUndefined()
    expect(projected.steps[0]!.rework).toBeUndefined()
    expect(projected.steps[0]!.testerQuality).toBeUndefined()
  })

  it('keeps what the board and the inspector actually read', () => {
    const source = run({
      steps: [
        {
          agentKind: 'coder',
          state: 'done',
          progress: 100,
          decision: null,
          output: 'prose',
          custom: { decision: 'auto_merged' },
          subtasks: { completed: 2, inProgress: 1, total: 3 },
          approval: { id: 'ap_1', status: 'pending' },
        },
      ],
    } as unknown as Partial<ExecutionInstance>)
    const step = projectExecutionForBoard(source).steps[0]!
    expect(step.custom).toEqual({ decision: 'auto_merged' })
    expect(step.subtasks).toEqual({ completed: 2, inProgress: 1, total: 3 })
    expect(step.approval?.id).toBe('ap_1')
  })

  it('states that it is a projection, so a reader can tell withheld from absent', () => {
    expect(projectExecutionForBoard(run()).projected).toBe(true)
  })

  it('leaves the source instance untouched', () => {
    const source = run()
    projectExecutionForBoard(source)
    expect(source.steps[0]!.output).toBe('a long prose answer')
    expect(source.projected).toBeUndefined()
  })

  it('still satisfies the wire schema the SPA re-validates the snapshot against', () => {
    // The SOURCE is the control: a fixture the schema already rejects would make this
    // assertion about the fixture rather than about the projection.
    const control = v.safeParse(executionInstanceSchema, run())
    expect(
      control.success
        ? []
        : control.issues.map((i) => `${i.path?.map((p) => p.key).join('.')}: ${i.message}`),
    ).toEqual([])
    const parsed = v.safeParse(executionInstanceSchema, projectExecutionForBoard(run()))
    expect(parsed.success ? [] : parsed.issues.map((i) => i.message)).toEqual([])
  })
})

describe('stepHasOutput', () => {
  it('answers the same question on a whole run and on its projection', () => {
    const source = run()
    const projected = projectExecutionForBoard(source)
    expect(source.steps.map(stepHasOutput)).toEqual([true, false])
    expect(projected.steps.map(stepHasOutput)).toEqual([true, false])
  })

  it('reads empty prose as no prose, on both shapes', () => {
    const source = run({
      steps: [{ agentKind: 'coder', state: 'done', progress: 100, decision: null, output: '' }],
    } as unknown as Partial<ExecutionInstance>)
    expect(stepHasOutput(source.steps[0]!)).toBe(false)
    expect(stepHasOutput(projectExecutionForBoard(source).steps[0]!)).toBe(false)
  })
})

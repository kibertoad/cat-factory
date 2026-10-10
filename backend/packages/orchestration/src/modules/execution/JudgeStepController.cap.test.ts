import { describe, expect, it, vi } from 'vitest'
import type {
  Block,
  ExecutionInstance,
  JudgeAssessor,
  JudgeStepState,
  PipelineStep,
  RunAutonomy,
} from '@cat-factory/kernel'
import { defaultJudgeRegistry, stubJudgeContext } from '@cat-factory/kernel'
import { JudgeStepController } from './JudgeStepController.js'
import { StepGraph } from './StepGraph.js'

// The judge's REWORK CAP, the fourth give-up park (ADR 0053 asks every new one to pick a side).
// Structurally the companion's — see `CompanionController.cap.test.ts`, whose two cases this
// mirrors deliberately, because the two caps must not drift apart.
//
// The half that is NOT shared is why this file exists: a judge parks for three different reasons
// and only ONE of them is the automation giving up. A policy that answered the other two would be
// waving through work nothing reviewed (`no_bounce_target`) or overruling an author who asked for
// a person (`registration`), so each is asserted to keep parking under the same unattended policy
// that settles the cap.

const WS = 'ws1'
const clock = { now: () => 1_000 }
const BLOCK = { id: 'blk_1', title: 'Add login', description: 'do the thing' } as Block

/** A verdict BELOW the 0.7 threshold, so a failing disposition is the one reached. */
const failing: JudgeAssessor = {
  enabled: true,
  assess: async () => ({
    verdict: { score: 0.4, summary: 'scope crept', findings: [] },
    model: 'm',
  }),
}

function judgeStep(over: Partial<JudgeStepState> = {}): PipelineStep {
  return {
    agentKind: 'scope',
    state: 'working',
    progress: 0,
    // Pre-seeded so `initState` reuses it rather than re-deriving from the preset: this is the
    // state AFTER the loop has spent what it was given, which is what the cap branch reads.
    judge: {
      status: 'evaluating',
      rubricId: 'r1',
      rubricName: 'Scope',
      rubricOverridden: false,
      threshold: 0.7,
      bounces: 1,
      maxBounces: 1,
      rounds: [],
      ...over,
    },
  } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'run_1',
    blockId: 'blk_1',
    pipelineId: 'pl_x',
    pipelineName: 'X',
    status: 'running',
    currentStep: steps.length - 1,
    steps,
    initiatedBy: null,
  } as unknown as ExecutionInstance
}

/**
 * A controller whose two observable outcomes are returned alongside it: `park` fires when the run
 * stopped for a person, `recordStepResult` when it advanced. Exactly one fires per case.
 */
function harness(autonomy: RunAutonomy, onFail: 'park' | 'bounce' = 'bounce') {
  const judgeRegistry = defaultJudgeRegistry()
  judgeRegistry.register('scope', () => ({
    kind: 'scope',
    rubric: { id: 'r1', name: 'Scope', body: 'DEFAULT RUBRIC' },
    onFail,
  }))
  const park = vi.fn(async () => ({ kind: 'awaiting_decision', decisionId: 'appr_1' }) as const)
  /** The step text the advance recorded, captured here because it is what a reader meets first. */
  const recorded: { output?: string } = {}
  const recordStepResult = vi.fn(
    async (
      _workspaceId: string,
      _instance: unknown,
      _step: unknown,
      _isFinalStep: boolean,
      result?: { output?: string },
    ) => {
      recorded.output = result?.output
      return { kind: 'continue' } as const
    },
  )
  const controller = new JudgeStepController({
    judgeRegistry,
    judgeAssessor: failing,
    executionRepository: { get: async () => null } as never,
    stateMachine: {
      casPersist: async () => {},
      emitInstance: async () => {},
      updateBlockProgress: async () => {},
      parkStepOnDecision: park,
    } as never,
    stepGraph: new StepGraph(clock),
    workRunner: { signalDecision: async () => {} } as never,
    clock,
    runInitiatorScope: (_initiatedBy: unknown, fn: () => unknown) => fn(),
    raiseNotification: async () => {},
    resolveRiskPolicy: async () => ({ judgeMinScore: 0.7, judgeMaxBounces: 1, autonomy }),
    recordStepResult,
    makeJudgeContext: () => stubJudgeContext(),
  } as never)
  return { controller, park, recordStepResult, recorded }
}

/** A producer precedes the judge, so `hasBounceTarget` is true and the cap is the reason it parks. */
const withProducer = () => [
  {
    agentKind: 'coder',
    state: 'done',
    progress: 1,
    output: 'the change',
  } as unknown as PipelineStep,
  judgeStep(),
]

describe('a judge at its rework cap', () => {
  it('parks for a person under an attended policy', async () => {
    const { controller, park, recordStepResult } = harness('attended')
    const inst = instance(withProducer())
    const judge = controller.judgeFor('scope')!
    const result = await controller.evaluate(WS, inst, inst.steps[1]!, BLOCK, false, judge)

    expect(park).toHaveBeenCalledOnce()
    expect(recordStepResult).not.toHaveBeenCalled()
    expect(result.kind).toBe('awaiting_decision')
    expect(inst.steps[1]!.judge?.status).toBe('awaiting_decision')
    expect(inst.steps[1]!.judge?.capSettledByPolicy).toBeUndefined()
  })

  it('advances under an unattended policy, stamping WHY it got past the bar', async () => {
    const { controller, park, recordStepResult, recorded } = harness('unattended')
    const inst = instance(withProducer())
    const judge = controller.judgeFor('scope')!
    await controller.evaluate(WS, inst, inst.steps[1]!, BLOCK, false, judge)

    expect(park).not.toHaveBeenCalled()
    expect(recordStepResult).toHaveBeenCalledOnce()
    const state = inst.steps[1]!.judge!
    expect(state.capSettledByPolicy).toBe(true)
    // The last round still records the FAILING verdict and its `park` disposition: the policy
    // answered the cap, it did not re-score the work.
    expect(state.rounds?.at(-1)?.disposition).toBe('park')
    expect(state.verdict?.score).toBe(0.4)
    // The note `disposeJudgeVerdict` wrote said "asking a human", and nobody was asked. A record
    // naming the wrong actor is the sentence a reviewer would quote.
    expect(state.note).not.toContain('asking a human')
    expect(state.note).toContain('risk policy')
    // And the step's own text says it did not clear the bar, rather than borrowing "passed".
    expect(recorded.output).toContain('did not clear the bar')
    expect(recorded.output).not.toContain('passed')
  })

  it('keeps parking when the judge itself asked for a human, however unattended the run', async () => {
    // `onFail: 'park'` is the registration's author saying a person decides. That is a park
    // somebody REQUESTED, in the same class as a pipeline's approval gate, and autonomy never
    // touches those — the whole line the feature is drawn on.
    const { controller, park, recordStepResult } = harness('unattended', 'park')
    const inst = instance(withProducer())
    const judge = controller.judgeFor('scope')!
    await controller.evaluate(WS, inst, inst.steps[1]!, BLOCK, false, judge)

    expect(park).toHaveBeenCalledOnce()
    expect(recordStepResult).not.toHaveBeenCalled()
    expect(inst.steps[1]!.judge?.capSettledByPolicy).toBeUndefined()
  })

  it('keeps parking when there was no producing step to bounce to', async () => {
    // The automation never got to TRY here, so accepting the work is a judgement rather than a
    // confirmation that it should stop trying. Settling it would advance a run past a failing
    // verdict that nothing ever reworked.
    const { controller, park, recordStepResult } = harness('unattended')
    const inst = instance([judgeStep({ bounces: 0 })])
    const judge = controller.judgeFor('scope')!
    await controller.evaluate(WS, inst, inst.steps[0]!, BLOCK, false, judge)

    expect(park).toHaveBeenCalledOnce()
    expect(recordStepResult).not.toHaveBeenCalled()
    expect(inst.steps[0]!.judge?.capSettledByPolicy).toBeUndefined()
    expect(inst.steps[0]!.judge?.note).toContain('No preceding producing step')
  })
})

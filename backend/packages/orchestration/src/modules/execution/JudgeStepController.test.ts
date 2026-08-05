import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, JudgeAssessor, PipelineStep } from '@cat-factory/kernel'
import { defaultJudgeRegistry, stubJudgeContext } from '@cat-factory/kernel'
import { JudgeStepController } from './JudgeStepController.js'
import { StepGraph } from './StepGraph.js'

// Unit coverage for the judge driver's non-obvious behaviours — the ones the cross-runtime
// conformance suite can't isolate: the rubric fragment override, and the "an assessment that
// blew up is a FAILING verdict, not a crashed run" rule.

const clock = { now: () => 1_000 }

function makeStep(kind: string, output?: string): PipelineStep {
  return {
    agentKind: kind,
    state: 'working',
    progress: 0,
    ...(output ? { output } : {}),
  } as unknown as PipelineStep
}

function makeInstance(steps: PipelineStep[]): ExecutionInstance {
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

const block = { id: 'blk_1', title: 'Add login', description: 'do the thing' } as Block

function makeController(overrides: {
  assessor?: JudgeAssessor
  fragmentBody?: string
  onFail?: 'park' | 'bounce' | 'fail'
  modelId?: string
}) {
  const judgeRegistry = defaultJudgeRegistry()
  judgeRegistry.register('scope', () => ({
    kind: 'scope',
    rubric: {
      id: 'r1',
      name: 'Scope',
      body: 'DEFAULT RUBRIC',
      fragmentId: 'frag_scope',
    },
    onFail: overrides.onFail ?? 'park',
    ...(overrides.modelId ? { modelId: overrides.modelId } : {}),
  }))
  const stepGraph = new StepGraph(clock)
  const recordStepResult = vi.fn(async () => ({ kind: 'continue' }) as const)
  const controller = new JudgeStepController({
    judgeRegistry,
    judgeAssessor: overrides.assessor,
    executionRepository: { get: async () => null } as never,
    stateMachine: {
      casPersist: async () => {},
      emitInstance: async () => {},
      updateBlockProgress: async () => {},
      parkStepOnDecision: async () =>
        ({ kind: 'awaiting_decision', decisionId: 'appr_1' }) as const,
    } as never,
    stepGraph,
    workRunner: { signalDecision: async () => {} } as never,
    clock,
    runInitiatorScope: (_initiatedBy, fn) => fn(),
    raiseNotification: async () => {},
    resolveRiskPolicy: async () => ({ judgeMinScore: 0.7, judgeMaxBounces: 1 }),
    ...(overrides.fragmentBody
      ? {
          fragmentResolver: {
            resolveBodiesForRun: async () => [{ id: 'frag_scope', body: overrides.fragmentBody! }],
          },
        }
      : {}),
    recordStepResult,
    makeJudgeContext: () => stubJudgeContext(),
  })
  return { controller, judgeRegistry, recordStepResult }
}

describe('JudgeStepController', () => {
  it('uses a workspace fragment as the rubric when one resolves, and says it did', async () => {
    const seen: string[] = []
    const assessor: JudgeAssessor = {
      enabled: true,
      assess: async (subject) => {
        seen.push(subject.rubric)
        return { verdict: { score: 1, summary: 'ok', findings: [] }, model: 'm' }
      },
    }
    const { controller } = makeController({ assessor, fragmentBody: 'WORKSPACE RUBRIC' })
    const step = makeStep('scope')
    const instance = makeInstance([makeStep('coder', 'built it'), step])
    const judge = controller.judgeFor('scope')!

    await controller.evaluate('ws', instance, step, block, false, judge)

    expect(seen).toEqual(['WORKSPACE RUBRIC'])
    expect(step.judge?.rubricOverridden).toBe(true)
  })

  it('falls back to the registration rubric when the library has no override', async () => {
    const seen: string[] = []
    const assessor: JudgeAssessor = {
      enabled: true,
      assess: async (subject) => {
        seen.push(subject.rubric)
        return { verdict: { score: 1, summary: 'ok', findings: [] }, model: 'm' }
      },
    }
    const { controller } = makeController({ assessor })
    const step = makeStep('scope')
    const instance = makeInstance([makeStep('coder', 'built it'), step])

    await controller.evaluate('ws', instance, step, block, false, controller.judgeFor('scope')!)

    expect(seen).toEqual(['DEFAULT RUBRIC'])
    expect(step.judge?.rubricOverridden).toBe(false)
  })

  it('turns a thrown assessment into a score-0 verdict rather than crashing the run', async () => {
    // The load-bearing rule: a judge exists to GATE, so "I could not tell" must land on the
    // cautious side of the threshold and reach a human — never abort the run with a stack
    // trace, and never let the work through.
    const assessor: JudgeAssessor = {
      enabled: true,
      assess: async () => {
        throw new Error('provider exploded')
      },
    }
    const { controller } = makeController({ assessor })
    const step = makeStep('scope')
    const instance = makeInstance([makeStep('coder', 'built it'), step])

    const result = await controller.evaluate(
      'ws',
      instance,
      step,
      block,
      false,
      controller.judgeFor('scope')!,
    )

    expect(result.kind).toBe('awaiting_decision')
    expect(step.judge?.verdict?.score).toBe(0)
    expect(step.judge?.verdict?.summary).toContain('provider exploded')
    expect(step.judge?.model).toBeNull()
  })

  it('hands the registration’s model pin to the assessment and records what became of it', async () => {
    const seen: (string | undefined)[] = []
    const assessor: JudgeAssessor = {
      enabled: true,
      assess: async (subject) => {
        seen.push(subject.modelId)
        return {
          verdict: { score: 1, summary: 'ok', findings: [] },
          model: 'cloudflare:glm',
          modelPin: { requested: subject.modelId!, status: 'unavailable' },
        }
      },
    }
    const { controller } = makeController({ assessor, modelId: 'claude-opus' })
    const step = makeStep('scope')
    const instance = makeInstance([makeStep('coder', 'built it'), step])

    await controller.evaluate('ws', instance, step, block, false, controller.judgeFor('scope')!)

    expect(seen).toEqual(['claude-opus'])
    // A rubric authored for one model and scored by another is recorded, not smoothed over: the
    // model name alone would read as the author's choice.
    expect(step.judge?.modelPin).toEqual({ requested: 'claude-opus', status: 'unavailable' })
    expect(step.judge?.model).toBe('cloudflare:glm')
  })

  it('records no pin for a judge that names no model', async () => {
    const assessor: JudgeAssessor = {
      enabled: true,
      assess: async () => ({ verdict: { score: 1, summary: 'ok', findings: [] }, model: 'm' }),
    }
    const { controller } = makeController({ assessor })
    const step = makeStep('scope')
    const instance = makeInstance([makeStep('coder', 'built it'), step])

    await controller.evaluate('ws', instance, step, block, false, controller.judgeFor('scope')!)

    expect(step.judge?.modelPin).toBeNull()
  })

  it('passes through with a note when no assessor is wired', async () => {
    const { controller, recordStepResult } = makeController({})
    const step = makeStep('scope')
    const instance = makeInstance([makeStep('coder', 'built it'), step])

    await controller.evaluate('ws', instance, step, block, false, controller.judgeFor('scope')!)

    expect(step.judge?.status).toBe('skipped')
    expect(step.judge?.note).toContain('no assessment model')
    expect(recordStepResult).toHaveBeenCalledOnce()
  })
})

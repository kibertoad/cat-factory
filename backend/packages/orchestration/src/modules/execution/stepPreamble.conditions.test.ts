import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep, StepOptions } from '@cat-factory/kernel'
import { AgentKindRegistry } from '@cat-factory/agents'
import type { RunServiceScope } from '@cat-factory/contracts'
import { runStepPreamble, type StepPreambleDeps } from './stepPreamble.js'

// The RUN CONDITION half of the pre-dispatch preamble: a step declaring a service scope runs only
// where the run changes a service of that kind, and is finished as `skipped` (with a note saying
// why) otherwise. Driven through `runStepPreamble` itself rather than a extracted predicate,
// because what is being asserted is the ORDER and the disposition — that the skip goes through the
// same door the estimate gate uses, and that nothing dispatches.

const WS = 'ws_1'

function step(options?: StepOptions): PipelineStep {
  return {
    agentKind: 'tester-ui',
    state: 'working',
    progress: 0,
    decision: null,
    requiresApproval: false,
    approval: null,
    ...(options ? { stepOptions: options } : {}),
  } as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_build',
    pipelineName: 'Standard build',
    steps,
    currentStep: 0,
    status: 'running',
    createdAt: 0,
  } as ExecutionInstance
}

const BLOCK = { id: 'blk_1', level: 'task' } as Block

/**
 * The recorded skip call, typed by what the assertions read: the NOTE, which is the whole
 * behavioural difference between a condition skip and an estimate skip.
 */
type SkipSpy = ReturnType<typeof vi.fn<StepPreambleDeps['skipGatedStep']>>

function deps(
  scope: RunServiceScope,
  skipGatedStep: SkipSpy = vi.fn<StepPreambleDeps['skipGatedStep']>(
    async () => ({ kind: 'noop' }) as never,
  ),
): { deps: StepPreambleDeps; skipGatedStep: SkipSpy } {
  return {
    skipGatedStep,
    deps: {
      spend: { isOverBudget: async () => false },
      accountOf: async () => null,
      currentStepIsNonMetered: async () => false,
      skipGatedStep,
      blockOf: async () => BLOCK,
      stateMachine: { persistAndEmit: async () => {} } as never,
      stepGraph: { startStep: () => {} } as never,
      inputGate: { evaluate: async () => null } as never,
      agentKindRegistry: new AgentKindRegistry(),
      serviceScopeOf: async () => scope,
    },
  }
}

describe('runStepPreamble — run conditions', () => {
  it('proceeds when the step declares no condition, without resolving a scope at all', async () => {
    const serviceScopeOf = vi.fn(async () => ({ frontend: false, backend: true }))
    const { deps: d } = deps({ frontend: false, backend: true })
    const s = step()
    const outcome = await runStepPreamble({ ...d, serviceScopeOf }, WS, instance([s]), s)
    expect(outcome.kind).toBe('proceed')
    // The guard that keeps a block-list read off every unconditional run.
    expect(serviceScopeOf).not.toHaveBeenCalled()
  })

  it('proceeds when the condition matches the run scope', async () => {
    const { deps: d, skipGatedStep } = deps({ frontend: true, backend: false })
    const s = step({ condition: { serviceScope: 'frontend' } })
    expect((await runStepPreamble(d, WS, instance([s]), s)).kind).toBe('proceed')
    expect(skipGatedStep).not.toHaveBeenCalled()
  })

  it('skips the step — with a note naming the reason — when the scope does not match', async () => {
    const { deps: d, skipGatedStep } = deps({ frontend: false, backend: true })
    const s = step({ condition: { serviceScope: 'frontend' } })
    const outcome = await runStepPreamble(d, WS, instance([s]), s)
    expect(outcome.kind).toBe('stop')
    expect(skipGatedStep).toHaveBeenCalledTimes(1)
    // A skip a reader cannot recover from the pipeline has to say why on the step itself: the
    // cause is a fact about the TASK, and "skipped" alone reads as a tester that did nothing.
    expect(skipGatedStep.mock.calls[0]?.[4]).toMatch(/frontend/i)
  })

  it('runs a conditional step when the scope could not be resolved', async () => {
    const { deps: d, skipGatedStep } = deps({ frontend: false, backend: false })
    const s = step({ condition: { serviceScope: 'frontend' } })
    expect((await runStepPreamble(d, WS, instance([s]), s)).kind).toBe('proceed')
    expect(skipGatedStep).not.toHaveBeenCalled()
  })

  it('leaves the ESTIMATE gate ahead of it: a gated-out step never resolves a scope', async () => {
    // Order matters only in that the estimate skip is the cheaper answer and carries no note; a
    // condition evaluated first would pay for a block-list read on a step already decided.
    const serviceScopeOf = vi.fn(async () => ({ frontend: true, backend: false }))
    const { deps: d, skipGatedStep } = deps({ frontend: true, backend: false })
    const s = {
      ...step({ condition: { serviceScope: 'frontend' } }),
      gating: { enabled: true, minComplexity: 0.9 },
    } as PipelineStep
    const outcome = await runStepPreamble(
      {
        ...d,
        serviceScopeOf,
        blockOf: async () =>
          ({ ...BLOCK, estimate: { complexity: 0.1, risk: 0.1, impact: 0.1 } }) as Block,
      },
      WS,
      instance([s]),
      s,
    )
    expect(outcome.kind).toBe('stop')
    expect(skipGatedStep).toHaveBeenCalledTimes(1)
    expect(skipGatedStep.mock.calls[0]?.[4]).toBeUndefined()
    expect(serviceScopeOf).not.toHaveBeenCalled()
  })
})

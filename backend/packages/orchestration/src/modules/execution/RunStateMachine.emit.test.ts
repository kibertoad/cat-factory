import type {
  Block,
  BlockRepository,
  ExecutionEventPublisher,
  ExecutionInstance,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { LlmObservabilityService } from '../observability/LlmObservabilityService.js'
import { RunStateMachine } from './RunStateMachine.js'

// emitInstance is the single live-push seam. A HEADLESS internal anchor block (a public-API
// "initiative" run) must NEVER reach the SPA: the board SNAPSHOT filters it, but the LIVE push path
// is the other half of that invariant. Without the guard, every step advance would broadcast the
// external run's brief (block.description) + LLM output (steps[].output) — and the hidden block
// itself — to every connected client. These tests pin that the live push is suppressed for an
// `internal` block and still fires for a normal one.

function makeInstance(blockId: string): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId,
    pipelineId: 'pl_initiative_breakdown',
    pipelineName: 'Break down initiative',
    steps: [],
    currentStep: 0,
    status: 'running',
  }
}

function makeMachine(block: Block | null) {
  const published: ExecutionInstance[] = []
  const events: ExecutionEventPublisher = {
    executionChanged: async (_workspaceId: string, instance: ExecutionInstance) => {
      published.push(instance)
    },
  } as unknown as ExecutionEventPublisher
  const blockRepository: BlockRepository = {
    get: async () => block,
  } as unknown as BlockRepository
  const machine = new RunStateMachine({
    executionRepository: {} as never,
    blockRepository,
    events,
    workRunner: {} as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: {} as never,
    stepGraph: {} as never,
  })
  return { machine, published }
}

const internalAnchor = { id: 'task_x', internal: true } as unknown as Block
const normalBlock = { id: 'task_y' } as unknown as Block

describe('RunStateMachine.emitInstance — internal-run live-push suppression', () => {
  it('does NOT publish an execution event for a headless internal anchor block', async () => {
    const { machine, published } = makeMachine(internalAnchor)
    await machine.emitInstance('ws_1', makeInstance('task_x'))
    expect(published).toHaveLength(0)
  })

  it('publishes an execution event for a normal (non-internal) block', async () => {
    const { machine, published } = makeMachine(normalBlock)
    await machine.emitInstance('ws_1', makeInstance('task_y'))
    expect(published).toHaveLength(1)
    expect(published[0]!.id).toBe('exec_1')
  })
})

// The metrics rollup is a per-run GROUP BY over llm_call_metrics; running it on every emit
// makes the drive loop pay O(emits × calls-in-run). The frequent progress-only poll folds pass
// `rollUpMetrics: false` to skip it, so these tests pin that the aggregate runs on a default
// (step-boundary/terminal) emit and is skipped on a progress-only fold.
describe('RunStateMachine.emitInstance — metrics rollup gating', () => {
  function makeMachineWithMetrics() {
    let summarizeCalls = 0
    const llmObservability = {
      summarizeByExecution: async () => {
        summarizeCalls += 1
        // The store returns the FINEST grain, one cell per (agentKind, phase); the step's
        // headline numbers are a fold up to the kind and `byPhase` is the same cells re-cut.
        return [
          {
            agentKind: 'coder',
            phase: 'agent',
            calls: 3,
            promptTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            completionTokens: 5,
            peakCompletionTokens: 5,
            maxOutputTokens: 100,
            truncatedCalls: 0,
            upstreamMs: 1,
            overheadMs: 1,
            errors: 0,
            warnings: 0,
            carryCostTokens: 20,
          },
          {
            agentKind: 'coder',
            phase: 'validation-repair',
            calls: 1,
            promptTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            completionTokens: 2,
            peakCompletionTokens: 2,
            maxOutputTokens: 100,
            truncatedCalls: 0,
            upstreamMs: 1,
            overheadMs: 1,
            errors: 0,
            warnings: 0,
            carryCostTokens: 900,
          },
        ]
      },
    } as unknown as LlmObservabilityService
    const events: ExecutionEventPublisher = {
      executionChanged: async () => {},
    } as unknown as ExecutionEventPublisher
    const blockRepository: BlockRepository = {
      get: async () => normalBlock,
    } as unknown as BlockRepository
    const machine = new RunStateMachine({
      executionRepository: {} as never,
      blockRepository,
      events,
      workRunner: {} as never,
      agentExecutor: {} as never,
      idGenerator: {} as never,
      clock: {} as never,
      stepGraph: {} as never,
      llmObservability,
    })
    return { machine, summarizeCalls: () => summarizeCalls }
  }

  function instanceWithCoderStep(): ExecutionInstance {
    return {
      ...makeInstance('task_y'),
      steps: [{ agentKind: 'coder', state: 'running', progress: 0 }],
    } as unknown as ExecutionInstance
  }

  it('rolls up metrics on a default (step-boundary/terminal) emit', async () => {
    const { machine, summarizeCalls } = makeMachineWithMetrics()
    const instance = instanceWithCoderStep()
    await machine.emitInstance('ws_1', instance)
    expect(summarizeCalls()).toBe(1)
    expect(instance.steps[0]!.metrics?.calls).toBe(4)
    // The per-phase breakdown rides the SAME aggregate — no second query on the emit path —
    // and leads with the phase that burdened the run most, not with store order.
    expect(instance.steps[0]!.metrics?.byPhase?.map((p) => [p.phase, p.calls])).toEqual([
      ['validation-repair', 1],
      ['agent', 3],
    ])
    expect(instance.steps[0]!.metrics?.carryCostTokens).toBe(920)
  })

  it('skips the rollup on a progress-only fold (rollUpMetrics: false)', async () => {
    const { machine, summarizeCalls } = makeMachineWithMetrics()
    const instance = instanceWithCoderStep()
    await machine.emitInstance('ws_1', instance, { rollUpMetrics: false })
    expect(summarizeCalls()).toBe(0)
    expect(instance.steps[0]!.metrics).toBeUndefined()
  })
})

// The currency labels every amount in a step's metrics payload — its own total AND each of its
// phases. Keying it on the total alone left a mixed-model step (the NORMAL shape, since a
// harness CLI serves some turns with a model of its own choosing) publishing priced phases with
// no denomination, because its total was null precisely BECAUSE one phase ran unpriced.
describe('RunStateMachine.emitInstance — cost currency labelling', () => {
  function makeMachineWithPricedCells(cells: unknown[], rollupCurrency: string | null) {
    const llmObservability = {
      rollupCurrency,
      summarizeByExecution: async () => cells,
    } as unknown as LlmObservabilityService
    return new RunStateMachine({
      executionRepository: {} as never,
      blockRepository: { get: async () => normalBlock } as unknown as BlockRepository,
      events: { executionChanged: async () => {} } as unknown as ExecutionEventPublisher,
      workRunner: {} as never,
      agentExecutor: {} as never,
      idGenerator: {} as never,
      clock: {} as never,
      stepGraph: {} as never,
      llmObservability,
    })
  }

  function pricedCell(phase: string, costEstimate: number | null) {
    return {
      agentKind: 'coder',
      phase,
      calls: 1,
      promptTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 5,
      peakCompletionTokens: 5,
      maxOutputTokens: 100,
      truncatedCalls: 0,
      upstreamMs: 1,
      overheadMs: 1,
      errors: 0,
      warnings: 0,
      carryCostTokens: 20,
      costEstimate,
    }
  }

  function coderStepInstance(): ExecutionInstance {
    return {
      ...makeInstance('task_y'),
      steps: [{ agentKind: 'coder', state: 'running', progress: 0 }],
    } as unknown as ExecutionInstance
  }

  it('labels the step when one phase is priced even though the TOTAL is not', async () => {
    const machine = makeMachineWithPricedCells(
      [pricedCell('agent', 0.5), pricedCell('validation-repair', null)],
      'EUR',
    )
    const instance = coderStepInstance()
    await machine.emitInstance('ws_1', instance)
    const metrics = instance.steps[0]!.metrics
    // The total declines to answer, because one phase could not be priced...
    expect(metrics?.costEstimate).toBeNull()
    // ...but the phase that WAS priced still carries money, so it needs its denomination.
    expect(metrics?.byPhase?.find((p) => p.phase === 'agent')?.costEstimate).toBeCloseTo(0.5, 10)
    expect(metrics?.costCurrency).toBe('EUR')
  })

  it('omits the currency when nothing in the payload is priced', async () => {
    // Absent, never a bare code: a denomination for numbers that are not there.
    const machine = makeMachineWithPricedCells([pricedCell('agent', null)], 'EUR')
    const instance = coderStepInstance()
    await machine.emitInstance('ws_1', instance)
    expect(instance.steps[0]!.metrics?.costCurrency).toBeUndefined()
  })

  it('omits the currency when the deployment prices nothing at all', async () => {
    const machine = makeMachineWithPricedCells([pricedCell('agent', null)], null)
    const instance = coderStepInstance()
    await machine.emitInstance('ws_1', instance)
    expect(instance.steps[0]!.metrics?.costCurrency).toBeUndefined()
  })
})

// The external trace's PARENTS (the run root + one span per agent kind) are emitted from this
// hook and nowhere else, because a run reaches a terminal state from several sites and any of
// them added later would otherwise emit nothing. Nothing about that placement is visible in the
// spans themselves, so these tests are what pin it: the previous coverage exercised the fold and
// the service in isolation, which would both stay green if the call site were deleted.
describe('RunStateMachine.emitInstance — external run-trace parents', () => {
  function makeMachineWithTrace() {
    const traced: string[] = []
    const llmObservability = {
      summarizeByExecution: async () => [],
      recordRunTrace: async (_workspaceId: string, instance: ExecutionInstance) => {
        traced.push(instance.status)
      },
    } as unknown as LlmObservabilityService
    const machine = new RunStateMachine({
      executionRepository: {} as never,
      blockRepository: { get: async () => normalBlock } as unknown as BlockRepository,
      events: { executionChanged: async () => {} } as unknown as ExecutionEventPublisher,
      workRunner: {} as never,
      agentExecutor: {} as never,
      idGenerator: {} as never,
      clock: {} as never,
      stepGraph: {} as never,
      llmObservability,
    })
    return { machine, traced }
  }

  function instanceWithStatus(status: ExecutionInstance['status']): ExecutionInstance {
    return { ...makeInstance('task_y'), status } as ExecutionInstance
  }

  it.each(['done', 'failed'] as const)('emits the trace parents on a %s run', async (status) => {
    const { machine, traced } = makeMachineWithTrace()
    await machine.emitInstance('ws_1', instanceWithStatus(status))
    expect(traced).toEqual([status])
  })

  it('emits nothing while the run is still going', async () => {
    // A root span emitted mid-run would claim an extent the run has not reached yet, and the
    // hook re-fires on the terminal emit anyway.
    const { machine, traced } = makeMachineWithTrace()
    await machine.emitInstance('ws_1', instanceWithStatus('running'))
    expect(traced).toEqual([])
  })

  it('emits on a progress-only fold of an already-terminal run', async () => {
    // `rollUpMetrics: false` suppresses the metrics query, never the trace: the parents are
    // idempotent by construction, so the cheap disposition is to re-emit rather than to reason
    // about which emit is the run's last.
    const { machine, traced } = makeMachineWithTrace()
    await machine.emitInstance('ws_1', instanceWithStatus('done'), { rollUpMetrics: false })
    expect(traced).toEqual(['done'])
  })

  it('still emits for a headless internal run, whose live push is suppressed', async () => {
    // The SPA must never see an internal anchor block, but an operator's trace backend is not
    // the SPA: dropping the parents here would orphan every span a public-API run exported.
    const { traced } = makeMachineWithTrace()
    const machine = new RunStateMachine({
      executionRepository: {} as never,
      blockRepository: { get: async () => internalAnchor } as unknown as BlockRepository,
      events: { executionChanged: async () => {} } as unknown as ExecutionEventPublisher,
      workRunner: {} as never,
      agentExecutor: {} as never,
      idGenerator: {} as never,
      clock: {} as never,
      stepGraph: {} as never,
      llmObservability: {
        summarizeByExecution: async () => [],
        recordRunTrace: async (_ws: string, instance: ExecutionInstance) => {
          traced.push(instance.status)
        },
      } as unknown as LlmObservabilityService,
    })
    await machine.emitInstance('ws_1', instanceWithStatus('done'))
    expect(traced).toEqual(['done'])
  })
})

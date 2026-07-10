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
        return [
          {
            agentKind: 'coder',
            calls: 4,
            promptTokens: 10,
            cachedPromptTokens: 0,
            completionTokens: 5,
            peakCompletionTokens: 5,
            maxOutputTokens: 100,
            truncatedCalls: 0,
            upstreamMs: 1,
            overheadMs: 1,
            errors: 0,
            warnings: 0,
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
  })

  it('skips the rollup on a progress-only fold (rollUpMetrics: false)', async () => {
    const { machine, summarizeCalls } = makeMachineWithMetrics()
    const instance = instanceWithCoderStep()
    await machine.emitInstance('ws_1', instance, { rollUpMetrics: false })
    expect(summarizeCalls()).toBe(0)
    expect(instance.steps[0]!.metrics).toBeUndefined()
  })
})

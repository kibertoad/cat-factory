import type {
  AgentRunContext,
  Block,
  ExecutionInstance,
  ModelProvider,
  ModelRef,
  PipelineStep,
} from '@cat-factory/kernel'
import type { SpendService } from '@cat-factory/spend'
import { AiAgentExecutor, defaultAgentKindRegistry } from '@cat-factory/agents'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { CompanionController } from './CompanionController.js'
import { recordJobFacts } from './job-facts.js'

// A PRODUCER and its COMPANION share one credential by construction: the companion grades the
// output of the step before it, in the same run, resolved through the same per-scope model
// provider. So the two ledger rows they file must agree about who pays for them.
//
// They did not. The producer's result carried the billing through `recordJobFacts`, while the
// companion's own `spend.record` call omitted the two fields entirely, and the inline executor
// asserted neither. One real run filed its `architect` as subscription usage and its
// `architect-companion`, one call later on the same host CLI login, as metered money on a
// deployment that had no metered credential to spend.
//
// Both halves are driven here against ONE provider, because either one alone passes with the
// other still broken.

const WS = 'ws1'
const BLOCK = { id: 'blk_1', title: 'A task' } as Block
/** What the companion must reply for its verdict to parse and the step to settle. */
const VERDICT = JSON.stringify({ rating: 0.9, summary: 'the design holds up' })

/** One credential serving every step of the run: a model declaring itself subscription-backed. */
function subscriptionProvider(): ModelProvider {
  return {
    resolve(_ref: ModelRef): ReturnType<ModelProvider['resolve']> {
      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: VERDICT }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 100, text: 100, reasoning: 0 },
          },
          warnings: [],
        }),
      })
      return Object.assign(model, {
        usageAttribution: { billing: 'subscription' as const, vendor: 'anthropic' },
      }) as unknown as ReturnType<ModelProvider['resolve']>
    },
  }
}

function executor(): AiAgentExecutor {
  return new AiAgentExecutor({
    modelProvider: subscriptionProvider(),
    agentRouting: {
      default: { ref: { provider: 'anthropic', model: 'claude-opus-5' } },
      byKind: {},
    },
    resolveBlockModel: () => undefined,
    agentContextRecorder: undefined,
  })
}

function contextFor(agentKind: string): AgentRunContext {
  return {
    agentKind: agentKind as AgentRunContext['agentKind'],
    pipelineName: 'design',
    stepIndex: 0,
    isFinalStep: false,
    block: { title: 'A task', type: 'service', description: 'Do the thing' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
  }
}

function run(): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_build',
    pipelineName: 'Standard build',
    steps: [
      { agentKind: 'architect', state: 'done', progress: 1, decision: null, output: 'the design' },
      {
        agentKind: 'architect-companion',
        state: 'working',
        progress: 0,
        decision: null,
        requiresApproval: false,
        approval: null,
      },
    ],
    currentStep: 1,
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
  } as ExecutionInstance
}

/** A registry holding the one rework pair, registered through the public seam. */
function pairRegistry() {
  const registry = defaultAgentKindRegistry()
  registry.register({ kind: 'architect', systemPrompt: 'You design.' })
  registry.register({ kind: 'architect-companion', systemPrompt: 'You grade designs.' })
  registry.registerCompanion({
    kind: 'architect-companion',
    targets: ['architect'],
    defaultThreshold: 0.8,
    reviews: 'the design',
  })
  return registry
}

/** The ledger, recording what each path files rather than pricing it. */
function recordingSpend() {
  const rows: { agentKind: string; billing?: string; vendor?: string | null }[] = []
  const spend = {
    record: async (input: { agentKind: string; billing?: string; vendor?: string | null }) => {
      rows.push(input)
      return 0
    },
  } as unknown as SpendService
  return { rows, spend }
}

describe('a companion and its producer file the same billing', () => {
  it('records both on the credential that served them, not on the path each ran through', async () => {
    const { rows, spend } = recordingSpend()
    const agent = executor()
    const instance = run()

    // The PRODUCER, through the generic step's fact recorder.
    const producerStep = instance.steps[0] as PipelineStep
    const producerResult = await agent.run(contextFor('architect'))
    await recordJobFacts(
      {
        clock: { now: () => 0 },
        spend,
        contextBuilder: {
          recordFoundationalDeclaration: async () => {},
          recordBinaryOutputDeclaration: async () => {},
        } as never,
      },
      WS,
      instance,
      producerStep,
      producerResult,
    )

    // The COMPANION, through its own controller, on the same executor.
    const companionStep = instance.steps[1] as PipelineStep
    const controller = new CompanionController({
      contextBuilder: {
        buildContext: async () => contextFor('architect-companion'),
      } as never,
      agentKindRegistry: pairRegistry(),
      spend,
      idGenerator: { next: (p: string) => `${p}_1` } as never,
      previewStepModel: async () => undefined,
      previewStepToolServers: async () => undefined,
      runAgent: (context) => agent.run(context),
      stateMachine: {
        casPersist: async () => {},
        persistAndEmit: async () => {},
        raiseDecisionRequired: async () => {},
        parkStepOnDecision: async () => ({ kind: 'awaiting_decision' as const, decisionId: 'a' }),
        settleStepAndAdvance: async () => ({ kind: 'continue' as const }),
      } as never,
      stepGraph: {
        finishStep: () => {},
        loopCompanionProducer: () => {},
        pauseStepForInput: () => {},
      } as never,
      resolveRiskPolicy: async () => ({ companionMaxReworks: 1, autonomy: 'attended' as const }),
    })
    await controller.evaluate(WS, instance, companionStep, BLOCK, false, {})

    expect(rows.map((r) => r.agentKind)).toEqual(['architect', 'architect-companion'])
    expect(rows.map((r) => r.billing)).toEqual(['subscription', 'subscription'])
    expect(rows.map((r) => r.vendor)).toEqual(['anthropic', 'anthropic'])
  })
})

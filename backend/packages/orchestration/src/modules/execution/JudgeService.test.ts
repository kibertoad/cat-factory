import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type {
  Block,
  JudgeSubject,
  ModelProvider,
  ModelRef,
  PipelineStep,
} from '@cat-factory/kernel'
import { JudgeService, type JudgeServiceDeps } from './JudgeService.js'
import type { PresetRouting } from '../modelPresets/ModelPresetService.js'

// Which model a rubric is scored by. The failure this covers is silent by construction: every
// path here returns a verdict, and only the recorded model + pin say whether it came from the
// model the rubric was written for. Drives the real `generateText` over the AI SDK's own test
// double, like `ForkChatService.test.ts`.

const GLM: ModelRef = { provider: 'cloudflare', model: 'glm' }
const OPUS: ModelRef = { provider: 'anthropic', model: 'claude-opus' }
const FALLBACK: ModelRef = { provider: 'qwen', model: 'qwen-coder' }

const CATALOG: Record<string, ModelRef> = { glm: GLM, 'claude-opus': OPUS }

function scriptedModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: '{"score":0.9,"summary":"ok","findings":[]}' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  })
}

const BLOCK = { id: 'blk_1', title: 'Login task', description: 'Fix the redirect.' } as Block

const STEP = { agentKind: 'scope-adherence', state: 'working' } as unknown as PipelineStep

function subject(over: Partial<JudgeSubject> = {}): JudgeSubject {
  return {
    workspaceId: 'ws_1',
    block: BLOCK,
    step: STEP,
    rubric: 'Do what was asked and nothing else.',
    rubricName: 'Scope adherence',
    priorOutputs: [{ agentKind: 'coder', output: 'built it' }],
    ...over,
  }
}

/** A service whose preset answers `routing`, recording which agent kind it was asked about. */
function makeService(routing: PresetRouting) {
  const kinds: string[] = []
  const deps: JudgeServiceDeps = {
    modelProvider: { resolve: () => scriptedModel() } satisfies ModelProvider,
    modelRef: FALLBACK,
    resolveBlockModel: (id) => (id ? CATALOG[id] : undefined),
    resolvePresetRouting: async (_ws, agentKind) => {
      kinds.push(agentKind)
      return routing
    },
  }
  return { service: new JudgeService(deps), kinds }
}

describe('JudgeService', () => {
  it('resolves under the JUDGE’S OWN kind, so each rubric is its own model default', async () => {
    // The whole reason a per-judge pin is possible: a shared `judge` key would collapse every
    // registered rubric onto one row of the model-defaults panel — a row that already lists them
    // separately, so the engine would have been ignoring what the panel offered.
    const { service, kinds } = makeService({ modelId: 'glm', pinnedForKind: false })

    await service.assess(subject())

    expect(kinds).toEqual(['scope-adherence'])
  })

  it('runs a declared pin when the preset only states a base model', async () => {
    const { service } = makeService({ modelId: 'glm', pinnedForKind: false })

    const result = await service.assess(subject({ modelId: 'claude-opus' }))

    expect(result.model).toBe('anthropic:claude-opus')
    expect(result.modelPin).toEqual({ requested: 'claude-opus', status: 'applied' })
  })

  it('yields to a workspace preset that NAMES the judge’s kind', async () => {
    const { service } = makeService({ modelId: 'glm', pinnedForKind: true })

    const result = await service.assess(subject({ modelId: 'claude-opus' }))

    expect(result.model).toBe('cloudflare:glm')
    expect(result.modelPin).toEqual({ requested: 'claude-opus', status: 'overridden' })
  })

  it('states an unservable pin instead of quietly scoring on the fallback', async () => {
    const { service } = makeService({ modelId: 'glm', pinnedForKind: false })

    const result = await service.assess(subject({ modelId: 'retired-model' }))

    expect(result.model).toBe('cloudflare:glm')
    expect(result.modelPin).toEqual({ requested: 'retired-model', status: 'unavailable' })
  })

  it('reports no pin for a judge that names no model', async () => {
    const { service } = makeService({ modelId: 'glm', pinnedForKind: false })

    const result = await service.assess(subject())

    expect(result.model).toBe('cloudflare:glm')
    expect(result.modelPin).toBeUndefined()
  })
})

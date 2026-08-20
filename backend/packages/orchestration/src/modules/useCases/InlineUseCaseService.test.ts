import { describe, expect, it } from 'vitest'
import type {
  InlineUseCaseDefinition,
  InlineUseCaseGenerationRequest,
  InlineUseCaseGenerator,
  InlineUseCaseModelAvailability,
  InlineUseCaseModelOption,
} from '@cat-factory/kernel'
import { DomainError, defaultInlineUseCaseRegistry } from '@cat-factory/kernel'
import { InlineUseCaseService } from './InlineUseCaseService.js'

// The rules between an authenticated request and the one model call: the model narrowing, the
// parameter validation, the generation bounds and the budget guard, each asserted through the
// refusal a caller actually receives (`code` + `details.reason`, which is what an integration
// branches on) rather than through the message.
//
// Driven against a deterministic fake generator, the same seam the conformance suite injects, so
// nothing here needs a provider.

const MODELS: InlineUseCaseModelOption[] = [
  {
    id: 'magnum',
    label: 'Magnum',
    source: { kind: 'provider', ref: { provider: 'novel', model: 'magnum-v4' } },
    default: true,
  },
  { id: 'flash', label: 'Gemini Flash', source: { kind: 'catalog', modelId: 'gemini' } },
]

const USE_CASE: InlineUseCaseDefinition = {
  useCaseId: 'acme:scene-prose',
  label: 'Scene prose',
  description: 'Write a scene from a beat sheet.',
  systemPrompt: 'You write game scenes.',
  models: MODELS,
  parameters: [
    { key: 'beats', label: 'Beat sheet', type: 'textarea', required: true },
    {
      key: 'tone',
      label: 'Tone',
      type: 'select',
      options: [
        { value: 'grim', label: 'Grim' },
        { value: 'warm', label: 'Warm' },
      ],
    },
  ],
  generation: { temperature: { default: 0.9, min: 0, max: 1.5 } },
}

interface FakeOptions {
  availability?: (option: InlineUseCaseModelOption) => InlineUseCaseModelAvailability
  text?: string
  finishReason?: 'stop' | 'length'
  enabled?: boolean
}

/** Records what it was asked to generate, so the composition can be asserted end to end. */
class FakeGenerator implements InlineUseCaseGenerator {
  readonly requests: InlineUseCaseGenerationRequest[] = []
  constructor(private readonly opts: FakeOptions = {}) {}
  get enabled(): boolean {
    return this.opts.enabled ?? true
  }
  availability(
    _workspaceId: string,
    option: InlineUseCaseModelOption,
  ): Promise<InlineUseCaseModelAvailability> {
    const answer =
      this.opts.availability?.(option) ??
      ({ available: true, ref: { provider: 'novel', model: 'magnum-v4' } } as const)
    return Promise.resolve(answer)
  }
  generate(request: InlineUseCaseGenerationRequest) {
    this.requests.push(request)
    return Promise.resolve({
      text: this.opts.text ?? 'They meet at dusk.',
      finishReason: this.opts.finishReason ?? ('stop' as const),
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ref: { provider: 'novel', model: 'magnum-v4' },
    })
  }
}

function build(
  opts: FakeOptions & { isOverBudget?: boolean; useCase?: InlineUseCaseDefinition } = {},
): { service: InlineUseCaseService; generator: FakeGenerator } {
  const registry = defaultInlineUseCaseRegistry()
  registry.register(opts.useCase ?? USE_CASE)
  const generator = new FakeGenerator(opts)
  return {
    generator,
    service: new InlineUseCaseService({
      registry,
      generator,
      isOverBudget: () => Promise.resolve(opts.isOverBudget ?? false),
    }),
  }
}

/** The refusal a caller branches on: the status class and the machine-readable cause. */
async function refusalOf(run: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await run
  } catch (error) {
    const domain = error as DomainError
    expect(domain).toBeInstanceOf(DomainError)
    return { code: domain.code, reason: (domain.details as { reason?: unknown })?.reason }
  }
  throw new Error('expected the invocation to be refused')
}

describe('discovery', () => {
  it('projects the catalog with the parameters, the bounds and the flagged default model', async () => {
    const { service } = build()
    const [useCase] = await service.list('ws_1')
    expect(useCase?.useCaseId).toBe('acme:scene-prose')
    expect(useCase?.parameters.map((p) => p.key)).toEqual(['beats', 'tone'])
    expect(useCase?.models.map((m) => ({ id: m.id, default: m.default }))).toEqual([
      { id: 'magnum', default: true },
      { id: 'flash', default: false },
    ])
    // A partially-declared bound folds over the platform default rather than replacing it.
    expect(useCase?.generation.temperature).toEqual({ default: 0.9, min: 0, max: 1.5 })
  })

  it('lists an unservable model WITH its cause instead of hiding it', async () => {
    // A wrapper rendering the picker still shows what the use case offers, and can tell "this
    // deployment never serves it" from "nobody has configured the credential yet".
    const { service } = build({
      availability: (option) =>
        option.id === 'flash'
          ? { available: false, reason: 'container_only' }
          : { available: true, ref: { provider: 'novel', model: 'magnum-v4' } },
    })
    const [useCase] = await service.list('ws_1')
    expect(useCase?.models.find((m) => m.id === 'flash')).toMatchObject({
      available: false,
      unavailableReason: 'container_only',
    })
  })

  it('still answers the catalog when no model provider is wired', async () => {
    // The honest split: an unconfigured deployment has a catalog and cannot run it. A 503 here
    // would tell a wrapper the surface does not exist when what is missing is a key.
    const { service } = build({ enabled: false })
    const [useCase] = await service.list('ws_1')
    expect(useCase?.models.every((m) => !m.available)).toBe(true)
    expect(useCase?.models[0]?.unavailableReason).toBe('provider_unavailable')
  })

  it('404s an unregistered id on the point read', async () => {
    const { service } = build()
    expect(await refusalOf(service.get('ws_1', 'acme:nope'))).toEqual({
      code: 'not_found',
      reason: 'use_case_not_found',
    })
  })
})

describe('invocation', () => {
  const invoke = (service: InlineUseCaseService, over: Record<string, unknown> = {}) =>
    service.invoke({
      workspaceId: 'ws_1',
      useCaseId: 'acme:scene-prose',
      parameters: { beats: 'They meet at dusk.', tone: 'grim' },
      ...over,
    })

  it('composes the declared prompt, runs the default model and reports the resolved ref', async () => {
    const { service, generator } = build()
    const result = await invoke(service)
    expect(generator.requests[0]).toMatchObject({
      system: 'You write game scenes.',
      prompt: 'Beat sheet: They meet at dusk.\nTone: Grim',
      temperature: 0.9,
      option: { id: 'magnum' },
    })
    expect(result.model).toEqual({
      id: 'magnum',
      label: 'Magnum',
      provider: 'novel',
      model: 'magnum-v4',
    })
    expect(result.truncated).toBe(false)
  })

  it('reports a reply that hit the output budget as truncated rather than as an answer', async () => {
    const { service } = build({ finishReason: 'length' })
    const result = await invoke(service)
    expect(result).toMatchObject({ finishReason: 'length', truncated: true })
  })

  it('refuses a model the use case does not carry, naming what it does', async () => {
    const { service, generator } = build()
    const refusal = await refusalOf(invoke(service, { model: 'gpt-nope' }))
    expect(refusal).toEqual({ code: 'validation', reason: 'use_case_model_not_allowed' })
    // Never substituted: the narrowing is the point, so nothing was generated at all.
    expect(generator.requests).toEqual([])
  })

  it('refuses a declared model this deployment cannot serve, rather than degrading to another', async () => {
    const { service, generator } = build({
      availability: () => ({ available: false, reason: 'provider_unavailable' }),
    })
    expect(await refusalOf(invoke(service))).toEqual({
      code: 'unavailable',
      reason: 'use_case_model_unavailable',
    })
    expect(generator.requests).toEqual([])
  })

  it('names every parameter problem at once', async () => {
    const { service } = build()
    const refusal = await refusalOf(
      service.invoke({
        workspaceId: 'ws_1',
        useCaseId: 'acme:scene-prose',
        parameters: { tone: 'lurid', surprise: 'x' },
      }),
    )
    expect(refusal).toEqual({ code: 'validation', reason: 'use_case_parameters_invalid' })
  })

  it('refuses a knob outside the declared bounds instead of clamping it', async () => {
    // Clamping would answer a request for one generation with a different one, reporting success.
    const { service } = build()
    expect(await refusalOf(invoke(service, { temperature: 1.9 }))).toEqual({
      code: 'validation',
      reason: 'use_case_generation_out_of_range',
    })
  })

  it('refuses fail-CLOSED when the workspace budget is spent', async () => {
    const { service, generator } = build({ isOverBudget: true })
    expect(await refusalOf(invoke(service))).toEqual({
      code: 'rate_limited',
      reason: 'budget_exhausted',
    })
    expect(generator.requests).toEqual([])
  })

  it('refuses an empty reply rather than answering 200 with an empty string', async () => {
    const { service } = build({ text: '   ' })
    expect(await refusalOf(invoke(service))).toEqual({
      code: 'unavailable',
      reason: 'use_case_empty_reply',
    })
  })

  it('names the deployment-level gap when no model provider is wired', async () => {
    const { service } = build({ enabled: false })
    expect(await refusalOf(invoke(service))).toEqual({
      code: 'unavailable',
      reason: 'use_case_models_unconfigured',
    })
  })
})

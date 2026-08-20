import { describe, expect, it } from 'vitest'
import type {
  InlineUseCaseDefinition,
  InlineUseCaseGenerationRequest,
  InlineUseCaseGenerator,
  InlineUseCaseModelAvailability,
  InlineUseCaseModelOption,
  InlineUseCaseScope,
  InlineUseCaseSession,
  RecordedLogLine,
} from '@cat-factory/kernel'
import {
  createRecordingLogger,
  DomainError,
  defaultInlineUseCaseRegistry,
} from '@cat-factory/kernel'
import { InlineUseCaseService } from './InlineUseCaseService.js'

// The rules between an authenticated request and the one model call: the model narrowing, the
// parameter validation, the generation bounds and the budget guard, each asserted through the
// refusal a caller actually receives (`code` + `details.reason`, which is what an integration
// branches on) rather than through the message.
//
// Plus the two the SHAPE of the seam is supposed to make impossible, both asserted by counting what
// the fake was asked to do: one credential-scope resolution per REQUEST however many models the
// catalog declares, and that resolution carrying all three credential tiers rather than only the
// workspace.
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

const SCOPE: InlineUseCaseScope = { workspaceId: 'ws_1', accountId: 'acc_1', userId: 'usr_1' }

interface FakeOptions {
  availability?: (option: InlineUseCaseModelOption) => InlineUseCaseModelAvailability
  text?: string
  finishReason?: 'stop' | 'length'
  enabled?: boolean
  /** Fail the credential-pool read, the one thing `forScope` is allowed to throw for. */
  poolFailure?: Error
}

/** Records every binding and every request, so the fan-out and the composition can be asserted. */
class FakeGenerator implements InlineUseCaseGenerator {
  readonly scopes: InlineUseCaseScope[] = []
  readonly requests: InlineUseCaseGenerationRequest[] = []
  constructor(private readonly opts: FakeOptions = {}) {}
  get enabled(): boolean {
    return this.opts.enabled ?? true
  }
  forScope(scope: InlineUseCaseScope): Promise<InlineUseCaseSession> {
    this.scopes.push(scope)
    if (this.opts.poolFailure) return Promise.reject(this.opts.poolFailure)
    const opts = this.opts
    const requests = this.requests
    return Promise.resolve({
      availability: (option: InlineUseCaseModelOption) =>
        opts.availability?.(option) ??
        ({ available: true, ref: { provider: 'novel', model: 'magnum-v4' } } as const),
      generate: (request: InlineUseCaseGenerationRequest) => {
        requests.push(request)
        return Promise.resolve({
          text: opts.text ?? 'They meet at dusk.',
          finishReason: opts.finishReason ?? ('stop' as const),
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          ref: { provider: 'novel', model: 'magnum-v4' },
        })
      },
    })
  }
}

function build(
  opts: FakeOptions & { isOverBudget?: boolean; useCase?: InlineUseCaseDefinition } = {},
): {
  service: InlineUseCaseService
  generator: FakeGenerator
  budgetScopes: InlineUseCaseScope[]
  logLines: RecordedLogLine[]
} {
  const registry = defaultInlineUseCaseRegistry()
  registry.register(opts.useCase ?? USE_CASE)
  const generator = new FakeGenerator(opts)
  const budgetScopes: InlineUseCaseScope[] = []
  const logLines: RecordedLogLine[] = []
  return {
    generator,
    budgetScopes,
    logLines,
    service: new InlineUseCaseService({
      registry,
      generator,
      logger: createRecordingLogger(logLines),
      isOverBudget: (scope) => {
        budgetScopes.push(scope)
        return Promise.resolve(opts.isOverBudget ?? false)
      },
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
    const [useCase] = await service.list(SCOPE)
    expect(useCase?.useCaseId).toBe('acme:scene-prose')
    expect(useCase?.parameters.map((p) => p.key)).toEqual(['beats', 'tone'])
    expect(useCase?.models.map((m) => ({ id: m.id, default: m.default }))).toEqual([
      { id: 'magnum', default: true },
      { id: 'flash', default: false },
    ])
    // A partially-declared bound folds over the platform default rather than replacing it.
    expect(useCase?.generation.temperature).toEqual({ default: 0.9, min: 0, max: 1.5 })
  })

  it('resolves the credential scope ONCE for the whole catalog, not once per model', async () => {
    // The regression this shape exists to prevent: resolving per option turned a read-scope GET
    // into an `accountOf` read, a configured-providers read and a key LEASE (a write, whose usage
    // stamp then skews rotation) for every declared model of every registered use case.
    const registry = defaultInlineUseCaseRegistry()
    registry.register(USE_CASE)
    registry.register({ ...USE_CASE, useCaseId: 'acme:barks' })
    const generator = new FakeGenerator()
    const service = new InlineUseCaseService({ registry, generator })

    const listed = await service.list(SCOPE)
    expect(listed).toHaveLength(2)
    // Two use cases, two models each: four availability answers off ONE binding.
    expect(listed.flatMap((entry) => entry.models)).toHaveLength(4)
    expect(generator.scopes).toHaveLength(1)
  })

  it('binds all three credential tiers, not just the workspace', async () => {
    // A user-scoped provider key and a personal local-runner endpoint are only in the pool when the
    // resolution names the user; the account's keys only when it names the account. Dropping either
    // reports a model this deployment CAN serve as `provider_unavailable`, which sends an operator
    // to configure a provider that is already configured.
    const { service, generator } = build()
    await service.list(SCOPE)
    expect(generator.scopes[0]).toEqual({
      workspaceId: 'ws_1',
      accountId: 'acc_1',
      userId: 'usr_1',
    })
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
    const [useCase] = await service.list(SCOPE)
    expect(useCase?.models.find((m) => m.id === 'flash')).toMatchObject({
      available: false,
      unavailableReason: 'container_only',
    })
  })

  it('still answers the catalog when no model provider is wired', async () => {
    // The honest split: an unconfigured deployment has a catalog and cannot run it. A 503 here
    // would tell a wrapper the surface does not exist when what is missing is a key.
    const { service } = build({ enabled: false })
    const [useCase] = await service.list(SCOPE)
    expect(useCase?.models.every((m) => !m.available)).toBe(true)
    expect(useCase?.models[0]?.unavailableReason).toBe('provider_unavailable')
  })

  it('answers the catalog when the credential pool cannot be read, and says so in the log', async () => {
    // A transient database error behind `forScope` used to reject the whole `Promise.all` and 500
    // the read this endpoint exists to always answer. It degrades, but loudly: the cause is on the
    // log line, because the two-member public vocabulary cannot express "the pool read failed".
    const { service, logLines } = build({ poolFailure: new Error('connection reset') })
    const [useCase] = await service.list(SCOPE)
    expect(useCase?.models.every((m) => !m.available)).toBe(true)
    expect(logLines.some((line) => /connection reset/.test(JSON.stringify(line.fields)))).toBe(true)
  })

  it('404s an unregistered id on the point read', async () => {
    const { service } = build()
    expect(await refusalOf(service.get(SCOPE, 'acme:nope'))).toEqual({
      code: 'not_found',
      reason: 'use_case_not_found',
    })
  })
})

describe('invocation', () => {
  const invoke = (service: InlineUseCaseService, over: Record<string, unknown> = {}) =>
    service.invoke({
      scope: SCOPE,
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
    // One binding for the whole invocation: the availability probe and the generation share it.
    expect(generator.scopes).toHaveLength(1)
  })

  it('probes the budget with the account and user tiers the key carries', async () => {
    // `SpendService.isOverBudget` consults the account ceiling only when the scope names it, so a
    // workspace-only probe lets an account past its monthly limit keep generating through whichever
    // of its workspaces is still under its own.
    const { service, budgetScopes } = build()
    await invoke(service)
    expect(budgetScopes).toEqual([{ workspaceId: 'ws_1', accountId: 'acc_1', userId: 'usr_1' }])
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
    // Never substituted: the narrowing is the point, so nothing was generated at all, and the
    // refusal came before the credential pool was even read.
    expect(generator.requests).toEqual([])
    expect(generator.scopes).toEqual([])
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

  it('propagates a credential-pool failure instead of blaming the model', async () => {
    // The opposite disposition from discovery, deliberately: "the pool could not be read" is not an
    // availability answer, and reporting it as one would send the caller to pick another model for
    // a fault that has nothing to do with the one they named.
    const { service } = build({ poolFailure: new Error('connection reset') })
    await expect(invoke(service)).rejects.toThrow('connection reset')
  })

  it('names every parameter problem at once', async () => {
    const { service } = build()
    const refusal = await refusalOf(
      service.invoke({
        scope: SCOPE,
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

  it('refuses fail-CLOSED when the budget is spent', async () => {
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

import { describe, expect, it } from 'vitest'
import type { InlineUseCaseDefinition } from './inline-use-case-registry.js'
import {
  composeUseCasePrompt,
  DEFAULT_USE_CASE_GENERATION,
  defaultInlineUseCaseRegistry,
  defaultUseCaseModelOption,
  renderUseCaseBrief,
  resolveUseCaseModelOption,
  useCaseGenerationLimits,
} from './inline-use-case-registry.js'

// The pure half of the inline use-case seam: the registry, the model narrowing, the generation
// bounds fold, and the default prompt composition. Everything a deployment's registration hits
// before any provider is involved.

const useCase = (over: Partial<InlineUseCaseDefinition> = {}): InlineUseCaseDefinition => ({
  useCaseId: 'acme:scene-prose',
  label: 'Scene prose',
  description: 'Write a scene from a beat sheet.',
  systemPrompt: 'You write game scenes.',
  models: [
    {
      id: 'magnum',
      label: 'Magnum',
      source: { kind: 'provider', ref: { provider: 'x', model: 'm' } },
    },
    {
      id: 'flash',
      label: 'Gemini Flash',
      source: { kind: 'catalog', modelId: 'gemini' },
      default: true,
    },
  ],
  ...over,
})

describe('InlineUseCaseRegistry', () => {
  it('starts empty, registers by reference and replaces a re-registered id', () => {
    const registry = defaultInlineUseCaseRegistry()
    expect(registry.all()).toEqual([])
    registry.register(useCase())
    registry.register(useCase({ label: 'Scene prose v2' }))
    expect(registry.all()).toHaveLength(1)
    expect(registry.get('acme:scene-prose')?.label).toBe('Scene prose v2')
    expect(registry.get('acme:missing')).toBeUndefined()
  })

  it('registers a batch in declaration order', () => {
    const registry = defaultInlineUseCaseRegistry()
    registry.registerAll([useCase(), useCase({ useCaseId: 'acme:dialogue' })])
    expect(registry.all().map((entry) => entry.useCaseId)).toEqual([
      'acme:scene-prose',
      'acme:dialogue',
    ])
  })
})

describe('model narrowing', () => {
  it('runs the flagged default when the invocation names no model', () => {
    expect(defaultUseCaseModelOption(useCase())?.id).toBe('flash')
    expect(resolveUseCaseModelOption(useCase(), undefined)?.id).toBe('flash')
  })

  it('falls back to the first option when nothing is flagged', () => {
    // Boot validation refuses this shape for a multi-model use case; the read path still answers
    // rather than throwing, so a registration problem surfaces at boot and not as a crash on an
    // unrelated request.
    const models = useCase().models.map((option) => ({ ...option, default: false }))
    expect(defaultUseCaseModelOption(useCase({ models }))?.id).toBe('magnum')
  })

  it('answers undefined for a model the use case does not carry, never the default', () => {
    // The whole point of a narrowed list: a caller asking for something else is refused upstream,
    // rather than silently generated on the use case's default model.
    expect(resolveUseCaseModelOption(useCase(), 'gpt-nope')).toBeUndefined()
    expect(resolveUseCaseModelOption(useCase(), 'magnum')?.id).toBe('magnum')
  })
})

describe('generation limits', () => {
  it('falls back to the platform bounds when a registration declares none', () => {
    expect(useCaseGenerationLimits(useCase())).toEqual(DEFAULT_USE_CASE_GENERATION)
  })

  it('folds a partially-declared bound over the platform default', () => {
    const limits = useCaseGenerationLimits(
      useCase({ generation: { temperature: { max: 1.2 }, maxOutputTokens: { default: 6_000 } } }),
    )
    expect(limits.temperature).toEqual({
      default: DEFAULT_USE_CASE_GENERATION.temperature.default,
      min: DEFAULT_USE_CASE_GENERATION.temperature.min,
      max: 1.2,
    })
    expect(limits.maxOutputTokens.default).toBe(6_000)
    expect(limits.maxOutputTokens.max).toBe(DEFAULT_USE_CASE_GENERATION.maxOutputTokens.max)
  })
})

describe('prompt composition', () => {
  const withParameters = useCase({
    parameters: [
      { key: 'beats', label: 'Beat sheet', type: 'textarea' },
      {
        key: 'tone',
        label: 'Tone',
        type: 'select',
        options: [{ value: 'grim', label: 'Grim' }],
      },
      { key: 'unanswered', label: 'Unanswered', type: 'text' },
    ],
  })

  it('renders answered parameters as a labelled brief, option captions preferred', () => {
    const brief = renderUseCaseBrief({
      useCaseId: withParameters.useCaseId,
      workspaceId: 'ws_1',
      parameters: { beats: 'They meet at dusk.', tone: 'grim' },
      fields: withParameters.parameters ?? [],
    })
    expect(brief).toBe('Beat sheet: They meet at dusk.\nTone: Grim')
  })

  it('omits an unanswered parameter rather than rendering an empty heading', () => {
    // A heading with nothing under it reads to a model as an instruction to invent one.
    const brief = renderUseCaseBrief({
      useCaseId: withParameters.useCaseId,
      workspaceId: 'ws_1',
      parameters: { beats: 'They meet at dusk.' },
      fields: withParameters.parameters ?? [],
    })
    expect(brief).not.toContain('Unanswered')
  })

  it('uses the declared system prompt and the default fold when no composer is registered', () => {
    const prompt = composeUseCasePrompt(withParameters, {
      useCaseId: withParameters.useCaseId,
      workspaceId: 'ws_1',
      parameters: { beats: 'They meet at dusk.' },
      fields: withParameters.parameters ?? [],
    })
    expect(prompt.system).toBe('You write game scenes.')
    expect(prompt.prompt).toBe('Beat sheet: They meet at dusk.')
  })

  it('lets a registration own the whole composition', () => {
    const composed = composeUseCasePrompt(
      useCase({ compose: () => ({ system: 'S', prompt: 'P' }) }),
      { useCaseId: 'acme:scene-prose', workspaceId: 'ws_1', parameters: {}, fields: [] },
    )
    expect(composed).toEqual({ system: 'S', prompt: 'P' })
  })
})

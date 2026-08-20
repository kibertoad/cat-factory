import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { InlineUseCaseDefinition } from '@cat-factory/kernel'
import { defaultGateRegistry, defaultInlineUseCaseRegistry } from '@cat-factory/kernel'
import { collectRegistrationProblems } from './validation/validateRegistrations.js'

// Boot validation of a deployment's INLINE USE CASES: the registration faults nothing at run time
// can recover from, caught where they can still be fixed.
//
// Each of these fails SILENTLY without the check. An unnamespaced id is unaddressable (the id IS
// the path segment); an ambiguous default model means an invocation naming no model runs on
// whichever the author happened to list first, and a reorder changes it for every such caller; a
// bound whose own default sits outside it refuses every invocation that omits the knob, naming a
// value the caller never sent.

const useCase = (over: Partial<InlineUseCaseDefinition> = {}): InlineUseCaseDefinition => ({
  useCaseId: 'acme:scene-prose',
  label: 'Scene prose',
  description: 'Write a scene from a beat sheet.',
  systemPrompt: 'You write game scenes.',
  models: [
    {
      id: 'magnum',
      label: 'Magnum',
      source: { kind: 'provider', ref: { provider: 'novel', model: 'magnum-v4' } },
      default: true,
    },
  ],
  ...over,
})

const codes = (...useCases: InlineUseCaseDefinition[]): string[] => {
  const inlineUseCaseRegistry = defaultInlineUseCaseRegistry()
  inlineUseCaseRegistry.registerAll(useCases)
  return collectRegistrationProblems({
    registries: {
      agentKindRegistry: defaultAgentKindRegistry(),
      gateRegistry: defaultGateRegistry(),
      inlineUseCaseRegistry,
    },
  })
    .filter((problem) => problem.code.startsWith('use_case_'))
    .map((problem) => problem.code)
}

describe('deployment-registered inline use cases', () => {
  it('accepts a well-formed registration', () => {
    expect(codes(useCase())).toEqual([])
  })

  it('refuses an id that is not namespaced', () => {
    expect(codes(useCase({ useCaseId: 'scene-prose' }))).toContain('use_case_bad_id')
  })

  it('refuses a use case that declares no models', () => {
    expect(codes(useCase({ models: [] }))).toContain('use_case_no_models')
  })

  it('refuses a duplicated model id', () => {
    const option = useCase().models[0]!
    expect(codes(useCase({ models: [option, { ...option, default: false }] }))).toContain(
      'use_case_duplicate_model',
    )
  })

  it('refuses several models with no stated default, and several defaults alike', () => {
    const first = useCase().models[0]!
    const second = { ...first, id: 'flash', label: 'Flash', default: false }
    expect(codes(useCase({ models: [{ ...first, default: false }, second] }))).toContain(
      'use_case_no_default_model',
    )
    expect(codes(useCase({ models: [first, { ...second, default: true }] }))).toContain(
      'use_case_ambiguous_default_model',
    )
  })

  it('accepts a SINGLE model with no default flag', () => {
    // Nothing to choose between, so the flag would be noise; the read path answers with it anyway.
    const only = { ...useCase().models[0]!, default: false }
    expect(codes(useCase({ models: [only] }))).toEqual([])
  })

  it('refuses a generation bound whose own default falls outside it', () => {
    expect(codes(useCase({ generation: { temperature: { default: 2, max: 1 } } }))).toContain(
      'use_case_default_outside_generation_range',
    )
    expect(codes(useCase({ generation: { maxOutputTokens: { min: 9_000, max: 100 } } }))).toContain(
      'use_case_bad_generation_range',
    )
  })

  it('holds the parameter form to the same bar every other descriptor form meets', () => {
    // The SHARED checker, under this surface's own code prefix: an optionless picker renders an
    // empty control, and a `showWhen` naming no declared field hides its own field forever.
    const problems = codes(
      useCase({
        parameters: [
          { key: 'tone', label: 'Tone', type: 'select' },
          { key: 'beats', label: 'Beats', showWhen: { key: 'missing', equals: 'x' } },
        ],
      }),
    )
    expect(problems).toContain('use_case_field_no_options')
    expect(problems).toContain('use_case_field_unknown_condition')
  })
})

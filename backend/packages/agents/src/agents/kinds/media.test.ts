import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import { MEDIA_GENERATOR_AGENT_KIND } from './media.js'
import { BINARY_OUTPUT_TRAIT, BINARY_STORAGE_TRAIT, hasTrait } from './traits.js'

// The Media task type's whole value is that a fresh deployment can run it, and every claim that
// makes that true is a property of THIS registration. Each assertion below is the one that turns
// off silently if the registration drifts.

describe('the built-in media-generator kind', () => {
  const registry = defaultAgentKindRegistry()

  it('is installed by the default registry', () => {
    expect(registry.get(MEDIA_GENERATOR_AGENT_KIND)).toBeDefined()
  })

  it('carries the binary-output trait, which is what earns it a brief at all', () => {
    // Without it the dispatch injects no `.cat-context/binary-output/brief.md`, run admission
    // validates no selection, and the fenced declaration in the reply is read back by nobody —
    // so the step runs, appears to succeed, and records nothing about what it stored.
    expect(hasTrait(MEDIA_GENERATOR_AGENT_KIND, BINARY_OUTPUT_TRAIT, registry)).toBe(true)
  })

  it('carries the binary-storage trait, which is the precondition on the account store', () => {
    // The storage it ships pointing at IS the platform's own artifact store, so a run with none
    // configured has nowhere to deliver. The trait is what refuses that up front with an
    // actionable conflict, instead of at the end of a paid generation.
    expect(hasTrait(MEDIA_GENERATOR_AGENT_KIND, BINARY_STORAGE_TRAIT, registry)).toBe(true)
  })

  it('runs read-only over a checkout and declares no structured output', () => {
    const definition = registry.get(MEDIA_GENERATOR_AGENT_KIND)!
    // Read-only: the trait guidance forbids committing binaries, and this kind opens no PR.
    expect(definition.agent?.surface).toBe('container-explore')
    // The deliverable is the fenced declaration block in the reply, not a JSON object. A schema
    // here would fail every run that did its job.
    expect(definition.structuredOutput).toBeUndefined()
  })

  it('is offered in the default palette, and only to a media pipeline', () => {
    const presentation = registry.get(MEDIA_GENERATOR_AGENT_KIND)!.presentation!
    expect(presentation.tier).toBe('basic')
    expect(presentation.purposes).toEqual(['media'])
    // No result view: `PipelineStep.binaryOutputs` renders through the shared report section,
    // which also covers a step whose artifacts were recorded under an overriding kind.
    expect(presentation.resultView).toBeUndefined()
  })
})

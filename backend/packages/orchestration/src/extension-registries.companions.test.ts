import { describe, expect, it } from 'vitest'
import {
  AgentKindRegistry,
  companionTargets,
  defaultAgentKindRegistry,
  isCompanionKind,
  systemPromptFor,
} from '@cat-factory/agents'
import { assertValidCompanionPlacement } from './modules/pipelines/pipelineShape.js'

// The COMPANION half of the installation-level extension seams (its siblings live in
// `extension-registries.test.ts`, which this was split out of when it crossed the file-size
// budget). A companion is the fourth thing a deployment can contribute alongside its own agent
// kinds, pipelines and task types, and it is the one that is a RELATIONSHIP rather than a thing:
// a producer, plus a reviewer that grades the producer's output and loops it back below a bar.
//
// Before this seam the only way to say that was a judge, which is a different machine: a judge
// scores against a rubric and disposes, where a companion drives the producer's own rework budget.

/** A deployment's own rework pair, registered the way a proprietary org package would. */
function registryWithPair(): AgentKindRegistry {
  const registry = defaultAgentKindRegistry()
  registry.register({ kind: 'acme:migrator', systemPrompt: 'You migrate schemas.' })
  registry.register({ kind: 'acme:migration-auditor', systemPrompt: 'You audit migrations.' })
  registry.registerCompanion({
    kind: 'acme:migration-auditor',
    targets: ['acme:migrator'],
    defaultThreshold: 0.75,
    reviews: 'schema migration for reversibility and data safety',
    surface: 'container-explore',
  })
  return registry
}

describe('companion registry', () => {
  it('answers every companion question for a registered pair, as it does for a built-in', () => {
    const registry = registryWithPair()
    expect(registry.isCompanionKind('acme:migration-auditor')).toBe(true)
    expect(registry.companionTargets('acme:migration-auditor')).toEqual(['acme:migrator'])
    expect(registry.companionFor('acme:migration-auditor')?.defaultThreshold).toBe(0.75)
    // The surface decides how the engine dispatches it, so it has to be answerable off the
    // registry too: an explore companion clones the producer's branch instead of grading a reply.
    expect(registry.isContainerBackedCompanion('acme:migration-auditor')).toBe(true)
    // ...and the producer is NOT a companion just for being reviewed by one.
    expect(registry.isCompanionKind('acme:migrator')).toBe(false)
  })

  it('pre-loads the built-in catalog, so registering one adds rather than replaces', () => {
    const registry = registryWithPair()
    expect(registry.companionTargets('reviewer')).toEqual(['coder'])
    expect(registry.isContainerBackedCompanion('reviewer')).toBe(true)
    expect(registry.allCompanions().map((c) => c.kind)).toContain('acme:migration-auditor')
  })

  it('is per-INSTANCE, so one deployment’s pair cannot leak into another registry', () => {
    // The whole reason this moved off a module-global `Map`: module identity stopped mattering
    // for a separately-published extension package, and a test builds a fresh registry rather
    // than clearing shared state.
    registryWithPair()
    expect(defaultAgentKindRegistry().isCompanionKind('acme:migration-auditor')).toBe(false)
  })

  it('lets the free lookups fall back to the built-ins when no registry is passed', () => {
    // The `isGatableKind` shape: a caller validating a built-in catalog has no registry and
    // needs none. A caller that COULD meet a deployment's companion passes one, which is why
    // every engine site threads it.
    expect(isCompanionKind('reviewer')).toBe(true)
    expect(isCompanionKind('acme:migration-auditor')).toBe(false)
    expect(isCompanionKind('acme:migration-auditor', registryWithPair())).toBe(true)
    expect(companionTargets('acme:migration-auditor', registryWithPair())).toEqual([
      'acme:migrator',
    ])
  })

  it('accepts a registered pair in a pipeline, and still enforces the adjacency rule', () => {
    const agentKindRegistry = registryWithPair()
    // Immediately after its target: valid, exactly as `coder` then `reviewer` is.
    expect(() =>
      assertValidCompanionPlacement({
        agentKinds: ['acme:migrator', 'acme:migration-auditor'],
        agentKindRegistry,
      }),
    ).not.toThrow()
    // Not after its target: refused. The engine reviews the immediate predecessor, so a
    // companion placed elsewhere would silently grade the wrong step's output.
    expect(() =>
      assertValidCompanionPlacement({
        agentKinds: ['acme:migrator', 'coder', 'acme:migration-auditor'],
        agentKindRegistry,
      }),
    ).toThrow()
    // Without the registry the pair is invisible, so the auditor reads as an ordinary step and
    // nothing is enforced. That is the documented cost of the optional argument, and the reason
    // both real boundaries (builder save, run start) pass it.
    expect(() =>
      assertValidCompanionPlacement({
        agentKinds: ['coder', 'acme:migration-auditor'],
      }),
    ).not.toThrow()
  })

  it('gives a registered companion its own review prompt, told to read the checkout', () => {
    const registry = registryWithPair()
    const prompt = systemPromptFor('acme:migration-auditor', registry)
    // The companion prompt wins over the generic fallback and names what it reviews.
    expect(prompt).toContain('schema migration for reversibility and data safety')
    expect(prompt).toContain('acme:migrator')
    // Its `container-explore` surface earns the read-the-real-repository instruction.
    expect(prompt).toContain('read-only checkout')
    expect(prompt).toContain('"rating"')
  })
})

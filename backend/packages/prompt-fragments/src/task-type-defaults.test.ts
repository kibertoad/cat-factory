import { describe, expect, it } from 'vitest'
import { defaultPromptFragmentRegistry } from '@cat-factory/kernel'
import { DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS } from './collections/style.js'
import { promptFragmentRegistryWithBuiltins } from './index.js'

// The per-task-type default sets, exercised through the app-owned registry that replaced the
// module global they used to live in. What is tested is mostly the same behaviour; what changed is
// that a deployment registers onto an INSTANCE, so two registries can hold different answers at
// once, which is what makes the two-physical-copies hazard unrepresentable rather than unlikely.

describe('built-in per-task-type default fragments', () => {
  it('seeds a document task with the writing-style set and every other type with nothing', () => {
    const registry = promptFragmentRegistryWithBuiltins()
    expect(registry.defaultFragmentIdsFor('document')).toEqual([
      ...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
    ])
    expect(registry.defaultFragmentIdsFor('review')).toEqual([])
    expect(registry.defaultFragmentIdsFor('feature')).toEqual([])
  })

  it('installs the shipped catalog through the same public seam a deployment uses', () => {
    // The point of `promptFragmentRegistryWithBuiltins` over a baked-in catalog: the platform
    // exercises the consumer's own registration path on every boot, so it cannot rot for consumers
    // only. A bare registry being EMPTY is what makes that visible.
    expect(defaultPromptFragmentRegistry().all()).toEqual([])
    expect(promptFragmentRegistryWithBuiltins().all().length).toBeGreaterThan(0)
  })
})

describe('deployment-registered per-task-type defaults', () => {
  it('returns exactly what was registered for the type', () => {
    const registry = promptFragmentRegistryWithBuiltins()
    registry.registerTaskTypeDefaults('review', ['org.review-checklist', 'org.security'])
    expect(registry.defaultFragmentIdsFor('review')).toEqual([
      'org.review-checklist',
      'org.security',
    ])
  })

  it('REPLACES the built-in set for the type rather than unioning with it', () => {
    // A behaviour change from the module-global seam, and the honest one: a deployment's
    // declaration is its final answer. The old silent union meant a shipped default could not be
    // removed however the call was written. A deployment that wants both spreads the exported ids
    // into its own list, which says so in the code.
    const registry = promptFragmentRegistryWithBuiltins()
    registry.registerTaskTypeDefaults('document', ['org.tone'])
    expect(registry.defaultFragmentIdsFor('document')).toEqual(['org.tone'])

    registry.registerTaskTypeDefaults('document', [
      ...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
      'org.tone',
    ])
    expect(registry.defaultFragmentIdsFor('document')).toEqual([
      ...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
      'org.tone',
    ])
  })

  it('lets the last registration for a type win, and dedupes its ids', () => {
    const registry = defaultPromptFragmentRegistry()
    registry.registerTaskTypeDefaults('review', ['org.a'])
    registry.registerTaskTypeDefaults('review', ['org.b', 'org.b'])
    expect(registry.defaultFragmentIdsFor('review')).toEqual(['org.b'])
  })

  it('keeps two registries independent, which is the whole point of injecting one', () => {
    // The regression the registry exists for, stated directly: with a module global, a second
    // physical copy of this package meant the registration landed in one map while every reader saw
    // the other, so an operation's tasks were seeded with ids that folded nothing.
    const registered = defaultPromptFragmentRegistry()
    const other = defaultPromptFragmentRegistry()
    registered.registerTaskTypeDefaults('review', ['org.a'])
    expect(registered.defaultFragmentIdsFor('review')).toEqual(['org.a'])
    expect(other.defaultFragmentIdsFor('review')).toEqual([])
  })
})

describe('the universal pool', () => {
  it('lets a deployment override a shipped fragment by re-registering its id', () => {
    const registry = promptFragmentRegistryWithBuiltins()
    const shipped = registry.all()[0]
    if (!shipped) throw new Error('the shipped catalog is empty')
    const before = registry.all().length
    registry.register({ ...shipped, body: 'the org’s own wording' })
    expect(registry.get(shipped.id)?.body).toBe('the org’s own wording')
    // An override REPLACES rather than appends: the pool a run folds must not carry one id twice,
    // or which body wins would depend on the reader's iteration order.
    expect(registry.all()).toHaveLength(before)
  })
})

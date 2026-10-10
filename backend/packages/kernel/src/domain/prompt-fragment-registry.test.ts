import { describe, expect, it } from 'vitest'
import { defaultPromptFragmentRegistry } from './prompt-fragment-registry.js'
import type { PromptFragment } from '@cat-factory/contracts'

// The seam that replaced two module globals in `@cat-factory/prompt-fragments`. Two rules carry
// the behaviour: re-registering an id REPLACES it (that is how a deployment refines a shipped
// standard, and how the built-ins install themselves through the same call), and a task type's
// default set is REPLACED rather than accumulated, so a later call is the deployment's final
// answer instead of a silent union with whatever ran before it.

const fragment = (id: string, over: Partial<PromptFragment> = {}): PromptFragment =>
  ({ id, title: id, body: `body of ${id}`, ...over }) as PromptFragment

describe('PromptFragmentRegistry', () => {
  it('starts EMPTY: even the shipped catalog installs itself through the public seam', () => {
    const registry = defaultPromptFragmentRegistry()
    expect(registry.all()).toEqual([])
    expect(registry.get('anything')).toBeUndefined()
    expect(registry.taskTypesWithDefaults()).toEqual([])
    expect(registry.defaultFragmentIdsFor('feature')).toEqual([])
  })

  it('keeps the pool in registration order and resolves by id', () => {
    const registry = defaultPromptFragmentRegistry()
    registry.registerAll([fragment('b'), fragment('a')])
    expect(registry.all().map((f) => f.id)).toEqual(['b', 'a'])
    expect(registry.get('a')?.body).toBe('body of a')
  })

  it('re-registering an id REPLACES it in place, which is how a built-in is refined', () => {
    const registry = defaultPromptFragmentRegistry()
    registry.registerAll([fragment('std_testing'), fragment('std_logging')])
    registry.register(fragment('std_testing', { body: 'the deployment’s own wording' }))
    expect(registry.all().map((f) => f.id)).toEqual(['std_testing', 'std_logging'])
    expect(registry.get('std_testing')?.body).toBe('the deployment’s own wording')
  })

  it('REPLACES a task type’s default set rather than accumulating onto it', () => {
    // Accumulating would make a deployment's later call a union with the built-ins' earlier one,
    // so a standard it deliberately dropped would keep being folded into every new task.
    const registry = defaultPromptFragmentRegistry()
    registry.registerTaskTypeDefaults('feature', ['std_testing', 'std_logging'])
    registry.registerTaskTypeDefaults('feature', ['std_logging'])
    expect(registry.defaultFragmentIdsFor('feature')).toEqual(['std_logging'])
  })

  it('dedupes a default set while keeping first-mention order', () => {
    const registry = defaultPromptFragmentRegistry()
    registry.registerTaskTypeDefaults('bug', ['a', 'b', 'a', 'c', 'b'])
    expect(registry.defaultFragmentIdsFor('bug')).toEqual(['a', 'b', 'c'])
  })

  it('snapshots the ids it was handed, so a caller’s later edits cannot reach the registry', () => {
    const registry = defaultPromptFragmentRegistry()
    const ids = ['a']
    registry.registerTaskTypeDefaults('bug', ids)
    ids.push('smuggled')
    expect(registry.defaultFragmentIdsFor('bug')).toEqual(['a'])
    registry.defaultFragmentIdsFor('bug').push('also-smuggled')
    expect(registry.defaultFragmentIdsFor('bug')).toEqual(['a'])
  })

  it('does NOT resolve the ids at registration time', () => {
    // A default set may legitimately name an account- or workspace-tier fragment that exists
    // only as a row, so refusing an unresolvable id here would refuse the org-wide living
    // document. Boot reports what the CODE pool cannot resolve; registration does not.
    const registry = defaultPromptFragmentRegistry()
    registry.registerTaskTypeDefaults('feature', ['tenant_only_fragment'])
    expect(registry.defaultFragmentIdsFor('feature')).toEqual(['tenant_only_fragment'])
    expect(registry.get('tenant_only_fragment')).toBeUndefined()
  })

  it('keeps default sets per task type and reports exactly the types carrying one', () => {
    const registry = defaultPromptFragmentRegistry()
    registry.registerTaskTypeDefaults('feature', ['std_testing'])
    registry.registerTaskTypeDefaults('document', ['std_writing'])
    expect(registry.taskTypesWithDefaults()).toEqual(['feature', 'document'])
    expect(registry.defaultFragmentIdsFor('document')).toEqual(['std_writing'])
    expect(registry.defaultFragmentIdsFor('spike')).toEqual([])
  })
})

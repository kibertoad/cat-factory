import { describe, expect, it } from 'vitest'
import { MapSourceRegistry } from './source-registry.logic.js'

// The by-kind lookup both the document- and task-source integrations build on. Its whole job is
// keying each provider by its OWN `kind`, so a mis-keyed entry resolves a request for one source
// onto another provider's client.

type Kind = 'github' | 'confluence' | 'notion'
const provider = (kind: Kind) => ({ kind, fetch: () => kind })

describe('MapSourceRegistry', () => {
  it('resolves a provider by its own `kind`, by reference', () => {
    const github = provider('github')
    const registry = new MapSourceRegistry<Kind, ReturnType<typeof provider>>([
      github,
      provider('confluence'),
    ])
    expect(registry.get('github')).toBe(github)
  })

  it('answers undefined for a kind nothing was wired for', () => {
    const registry = new MapSourceRegistry<Kind, ReturnType<typeof provider>>([provider('github')])
    expect(registry.get('notion')).toBeUndefined()
  })

  it('lists every wired provider, in construction order', () => {
    const registry = new MapSourceRegistry<Kind, ReturnType<typeof provider>>([
      provider('notion'),
      provider('github'),
    ])
    expect(registry.list().map((p) => p.kind)).toEqual(['notion', 'github'])
  })

  it('keeps the LAST provider when two share a kind, rather than both', () => {
    const second = provider('github')
    const registry = new MapSourceRegistry<Kind, ReturnType<typeof provider>>([
      provider('github'),
      second,
    ])
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('github')).toBe(second)
  })

  it('is empty when nothing is wired', () => {
    const registry = new MapSourceRegistry<Kind, ReturnType<typeof provider>>([])
    expect(registry.list()).toEqual([])
    expect(registry.get('github')).toBeUndefined()
  })
})

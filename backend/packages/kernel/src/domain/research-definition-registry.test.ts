import { describe, expect, it } from 'vitest'
import type { ResearchDefinitionInput } from '@cat-factory/contracts'
import {
  ResearchDefinitionRegistry,
  researchDefinitionContentHash,
} from './research-definition-registry.js'

function definition(version: number, question = 'Which auth scheme?'): ResearchDefinitionInput {
  return {
    key: 'acme:vendor',
    version,
    title: 'Vendor',
    brief: 'Learn the vendor.',
    topics: [{ id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question }] }],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
  }
}

describe('ResearchDefinitionRegistry', () => {
  it('serves each version and the latest', () => {
    const registry = new ResearchDefinitionRegistry()
    registry.registerAll([definition(2), definition(1)])
    expect(registry.get('acme:vendor', 1)?.version).toBe(1)
    expect(registry.latest('acme:vendor')?.version).toBe(2)
    expect(registry.all().map((d) => d.version)).toEqual([1, 2])
    expect(registry.has('acme:vendor')).toBe(true)
    expect(registry.latest('acme:other')).toBeUndefined()
  })

  it('refuses an invalid definition at registration', () => {
    const registry = new ResearchDefinitionRegistry()
    expect(() => registry.register({ ...definition(1), key: 'no-namespace' })).toThrow(
      /invalid research definition/,
    )
  })

  it('refuses re-registering a version with different content, and accepts an identical one', () => {
    const registry = new ResearchDefinitionRegistry()
    registry.register(definition(1))
    expect(() => registry.register(definition(1))).not.toThrow()
    expect(() => registry.register(definition(1, 'Something else?'))).toThrow(/new version/)
  })
})

describe('researchDefinitionContentHash', () => {
  it('ignores key order and changes with content', async () => {
    const registry = new ResearchDefinitionRegistry()
    registry.register(definition(1))
    const stored = registry.get('acme:vendor', 1)!
    const reordered = Object.fromEntries(Object.entries(stored).reverse()) as typeof stored
    expect(await researchDefinitionContentHash(reordered)).toBe(
      await researchDefinitionContentHash(stored),
    )
    const other = new ResearchDefinitionRegistry()
    other.register(definition(1, 'Something else?'))
    expect(await researchDefinitionContentHash(other.get('acme:vendor', 1)!)).not.toBe(
      await researchDefinitionContentHash(stored),
    )
  })
})

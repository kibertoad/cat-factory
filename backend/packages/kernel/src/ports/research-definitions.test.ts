import type { ResearchDefinition } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { ResearchDefinitionRegistry } from '../domain/research-definition-registry.js'
import {
  composeResearchDefinitionSource,
  registryResearchDefinitionSource,
} from './research-definitions.js'
import type {
  ResearchDefinitionRepository,
  StoredResearchDefinition,
} from './research-repositories.js'

function definition(key: string, version: number): ResearchDefinition {
  return {
    key,
    version,
    title: key,
    brief: 'Learn the vendor.',
    topics: [{ id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question: 'Which?' }] }],
    credentials: [],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    inputs: [],
    promptAdditions: {},
  }
}

function storedRepo(rows: StoredResearchDefinition[]): ResearchDefinitionRepository {
  return {
    get: async (accountId, key, version) =>
      rows.find(
        (r) =>
          r.accountId === accountId && r.definition.key === key && r.definition.version === version,
      ) ?? null,
    listByAccount: async (accountId) => rows.filter((r) => r.accountId === accountId),
    insert: async () => true,
  }
}

function source() {
  const registry = new ResearchDefinitionRegistry()
  registry.registerAll([definition('platform:vendor', 1), definition('platform:vendor', 3)])
  return composeResearchDefinitionSource({
    registered: registryResearchDefinitionSource(registry),
    stored: storedRepo([
      {
        accountId: 'acc_a',
        definition: definition('acme:crm', 2),
        contentHash: 'h2',
        createdAt: 1,
      },
      {
        accountId: 'acc_a',
        definition: definition('acme:crm', 5),
        contentHash: 'h5',
        createdAt: 2,
      },
      {
        accountId: 'acc_b',
        definition: definition('beta:crm', 1),
        contentHash: 'b1',
        createdAt: 1,
      },
    ]),
  })
}

describe('composeResearchDefinitionSource', () => {
  it('resolves a registered definition with its content hash', async () => {
    const resolved = await source().get('acc_a', 'platform:vendor', 1)
    expect(resolved?.origin).toBe('registered')
    expect(resolved?.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect((await source().latest('acc_b', 'platform:vendor'))?.definition.version).toBe(3)
  })

  it("resolves only the account's own stored definitions", async () => {
    expect(await source().get('acc_a', 'acme:crm', 2)).toMatchObject({
      origin: 'stored',
      contentHash: 'h2',
    })
    expect((await source().latest('acc_a', 'acme:crm'))?.definition.version).toBe(5)
    expect(await source().get('acc_b', 'acme:crm', 2)).toBeNull()
    expect(await source().latest('acc_a', 'acme:missing')).toBeNull()
  })

  it('lists registered definitions before the account stored ones', async () => {
    const listed = await source().list('acc_a')
    expect(listed.map((d) => `${d.origin}:${d.definition.key}@${d.definition.version}`)).toEqual([
      'registered:platform:vendor@1',
      'registered:platform:vendor@3',
      'stored:acme:crm@2',
      'stored:acme:crm@5',
    ])
  })
})

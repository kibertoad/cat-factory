import { type ProjectDefinitionSpecValidator, researchSpecValidator } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { ProjectDefinitionRegistry } from '../domain/project-definition-registry.js'
import type {
  ProjectDefinitionRepository,
  StoredProjectDefinition,
} from './project-outcome-repositories.js'
import {
  composeProjectDefinitionSource,
  registryProjectDefinitionSource,
} from './project-definitions.js'

function research(key: string, version: number) {
  return {
    kind: 'research',
    key,
    version,
    title: key,
    credentials: [],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' as const }],
    inputs: [],
    promptAdditions: {},
    spec: {
      brief: 'Learn the vendor.',
      topics: [{ id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question: 'Which?' }] }],
    },
  }
}

function notes(key: string, version: number) {
  return {
    kind: 'notes',
    key,
    version,
    title: key,
    credentials: [],
    targets: [],
    inputs: [],
    promptAdditions: {},
    spec: { heading: 'Decisions' },
  }
}

const notesValidator: ProjectDefinitionSpecValidator = {
  kind: 'notes',
  parseSpec: (definition) => ({ ok: true, value: definition.spec }),
}

function storedRepo(rows: StoredProjectDefinition[]): ProjectDefinitionRepository {
  return {
    get: async (accountId, kind, key, version) =>
      rows.find(
        (r) =>
          r.accountId === accountId &&
          r.definition.kind === kind &&
          r.definition.key === key &&
          r.definition.version === version,
      ) ?? null,
    listByAccount: async (accountId, kind) =>
      rows.filter((r) => r.accountId === accountId && r.definition.kind === kind),
    insert: async () => true,
  }
}

const row = (accountId: string, definition: StoredProjectDefinition['definition'], hash: string) =>
  ({ accountId, definition, contentHash: hash, createdAt: 1 }) satisfies StoredProjectDefinition

function source() {
  const registry = new ProjectDefinitionRegistry([researchSpecValidator, notesValidator])
  registry.registerAll([
    research('platform:vendor', 1),
    research('platform:vendor', 3),
    notes('platform:vendor', 7),
  ])
  return composeProjectDefinitionSource({
    registered: registryProjectDefinitionSource(registry),
    stored: storedRepo([
      row('acc_a', research('acme:crm', 2), 'h2'),
      row('acc_a', research('acme:crm', 5), 'h5'),
      row('acc_a', notes('acme:crm', 9), 'n9'),
      row('acc_b', research('beta:crm', 1), 'b1'),
    ]),
  })
}

describe('composeProjectDefinitionSource', () => {
  it('resolves a registered definition with its content hash', async () => {
    const resolved = await source().get('acc_a', 'research', 'platform:vendor', 1)
    expect(resolved?.origin).toBe('registered')
    expect(resolved?.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(
      (await source().latest('acc_b', 'research', 'platform:vendor'))?.definition.version,
    ).toBe(3)
  })

  it("resolves only the account's own stored definitions", async () => {
    expect(await source().get('acc_a', 'research', 'acme:crm', 2)).toMatchObject({
      origin: 'stored',
      contentHash: 'h2',
    })
    expect((await source().latest('acc_a', 'research', 'acme:crm'))?.definition.version).toBe(5)
    expect(await source().get('acc_b', 'research', 'acme:crm', 2)).toBeNull()
    expect(await source().latest('acc_a', 'research', 'acme:missing')).toBeNull()
  })

  it('keeps one key under two kinds apart', async () => {
    expect((await source().latest('acc_a', 'notes', 'platform:vendor'))?.definition.version).toBe(7)
    expect((await source().latest('acc_a', 'notes', 'acme:crm'))?.definition.version).toBe(9)
    expect(await source().get('acc_a', 'notes', 'platform:vendor', 1)).toBeNull()
  })

  it("lists one kind's registered definitions before the account's stored ones", async () => {
    const listed = await source().list('acc_a', 'research')
    expect(listed.map((d) => `${d.origin}:${d.definition.key}@${d.definition.version}`)).toEqual([
      'registered:platform:vendor@1',
      'registered:platform:vendor@3',
      'stored:acme:crm@2',
      'stored:acme:crm@5',
    ])
  })
})

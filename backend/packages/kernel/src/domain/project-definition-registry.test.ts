import { describe, expect, it } from 'vitest'
import {
  type ProjectDefinitionSpecValidator,
  type ResearchDefinitionInput,
  researchSpecValidator,
} from '@cat-factory/contracts'
import {
  ProjectDefinitionRegistry,
  projectDefinitionContentHash,
} from './project-definition-registry.js'

function research(version: number, question = 'Which auth scheme?'): ResearchDefinitionInput {
  return {
    kind: 'research',
    key: 'acme:vendor',
    version,
    title: 'Vendor',
    spec: {
      brief: 'Learn the vendor.',
      topics: [{ id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question }] }],
    },
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
  }
}

/** A second kind with a spec of a different shape, so nothing here is research-shaped. */
const notesValidator: ProjectDefinitionSpecValidator = {
  kind: 'notes',
  parseSpec: (definition) =>
    typeof (definition.spec as { heading?: unknown })?.heading === 'string'
      ? { ok: true, value: definition.spec }
      : { ok: false, issues: ['spec.heading: required'] },
}

function notes(version: number, heading: unknown = 'Decisions') {
  return { kind: 'notes', key: 'acme:vendor', version, title: 'Notes', spec: { heading } }
}

function registry() {
  return new ProjectDefinitionRegistry([researchSpecValidator, notesValidator])
}

describe('ProjectDefinitionRegistry', () => {
  it('serves each version and the latest, keyed by kind as well as key', () => {
    const defs = registry()
    defs.registerAll([research(2), research(1), notes(1)])
    expect(defs.get('research', 'acme:vendor', 1)?.version).toBe(1)
    expect(defs.latest('research', 'acme:vendor')?.version).toBe(2)
    expect(defs.list('research').map((d) => d.version)).toEqual([1, 2])
    expect(defs.list('notes').map((d) => d.spec)).toEqual([{ heading: 'Decisions' }])
    expect(defs.has('notes', 'acme:vendor')).toBe(true)
    expect(defs.latest('research', 'acme:other')).toBeUndefined()
  })

  it('refuses an invalid envelope, an unknown kind, and a spec its kind refuses', () => {
    const defs = registry()
    expect(() => defs.register({ ...research(1), key: 'no-namespace' })).toThrow(
      /invalid project definition/,
    )
    expect(() => defs.register({ ...notes(1), kind: 'unknown' })).toThrow(/no spec validator/)
    expect(() => defs.register(notes(1, 42))).toThrow(/invalid notes definition/)
    expect(() => defs.register({ ...research(1), targets: [] })).toThrow(
      /invalid research definition/,
    )
  })

  it('refuses re-registering a version with different content, and accepts an identical one', () => {
    const defs = registry()
    defs.register(research(1))
    expect(() => defs.register(research(1))).not.toThrow()
    expect(() => defs.register(research(1, 'Something else?'))).toThrow(/new version/)
  })
})

describe('projectDefinitionContentHash', () => {
  it('ignores key order and changes with content', async () => {
    const defs = registry()
    defs.register(research(1))
    const stored = defs.get('research', 'acme:vendor', 1)!
    const reordered = Object.fromEntries(Object.entries(stored).reverse()) as typeof stored
    expect(await projectDefinitionContentHash(reordered)).toBe(
      await projectDefinitionContentHash(stored),
    )
    const other = registry()
    other.register(research(1, 'Something else?'))
    expect(await projectDefinitionContentHash(other.get('research', 'acme:vendor', 1)!)).not.toBe(
      await projectDefinitionContentHash(stored),
    )
  })
})

import { describe, expect, it } from 'vitest'
import type { ResearchDefinitionInput } from '@cat-factory/contracts'
import {
  ProjectDefinitionRegistry,
  projectDefinitionContentHash,
} from './project-definition-registry.js'
import { type ProjectKindModule, eraseTaskHandler } from './project-kind-module.js'
import { researchKindModule } from './research-kind.js'

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
const notesModule: ProjectKindModule = {
  kind: 'notes',
  handlers: [
    eraseTaskHandler<unknown>({
      taskType: 'acme:note',
      agentKind: 'note-taker',
      outcomeSchemaVersion: 1,
      parseOutcome: (_version, value) => value,
      planTask: () => ({ intent: 'write', stream: 'main', plan: {} }),
      brief: () => ({}),
      mergeCheckpoint: (_earlier, later) => later,
      finish: ({ reply }) => ({ body: reply, output: '' }),
      describe: () => '',
      artifactRefs: () => [],
      parseConfig: (config) =>
        typeof (config as { topic?: unknown })?.topic === 'string'
          ? { ok: true, value: config }
          : { ok: false, issues: ['topic: required'] },
    }),
  ],
  parseSpec: (definition) =>
    typeof (definition.spec as { heading?: unknown })?.heading === 'string'
      ? { ok: true, value: definition.spec }
      : { ok: false, issues: ['spec.heading: required'] },
  definitionSummary: (definition) => definition.title,
}

function notes(version: number, heading: unknown = 'Decisions') {
  return { kind: 'notes', key: 'acme:vendor', version, title: 'Notes', spec: { heading } }
}

function registry() {
  return new ProjectDefinitionRegistry([researchKindModule, notesModule])
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
    expect(() => defs.register(notes(1, 42))).toThrow(/notes definition/)
    expect(() => defs.register({ ...research(1), targets: [] })).toThrow(/research definition/)
  })

  it('refuses re-registering a version with different content, and accepts an identical one', () => {
    const defs = registry()
    defs.register(research(1))
    expect(() => defs.register(research(1))).not.toThrow()
    expect(() => defs.register(research(1, 'Something else?'))).toThrow(/new version/)
  })

  it('holds the spec as its kind normalizes it, so whitespace is not a new version', () => {
    const defs = registry()
    defs.register(research(1, '  Which auth scheme?  '))
    expect(() => defs.register(research(1))).not.toThrow()
    expect(defs.get('research', 'acme:vendor', 1)?.spec).toMatchObject({
      topics: [{ questions: [{ question: 'Which auth scheme?' }] }],
    })
  })
})

describe('ProjectDefinitionRegistry stages', () => {
  const stage = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: id,
    taskType: 'acme:note',
    produces: id,
    config: { topic: ` ${id}` },
    ...over,
  })

  it("validates each stage's config with its task type's handler and stores it normalized", () => {
    const defs = registry()
    defs.register({ ...notes(1), stages: [stage('a'), stage('b', { after: ['a'] })] })
    expect(
      defs.get('notes', 'acme:vendor', 1)?.stages.map((s) => [s.id, s.start, s.config]),
    ).toEqual([
      ['a', 'manual', { topic: ' a' }],
      ['b', 'manual', { topic: ' b' }],
    ])
  })

  it('refuses a stage whose task type the kind does not offer, or whose config its handler refuses', () => {
    expect(() =>
      registry().register({ ...notes(1), stages: [stage('a', { taskType: 'research' })] }),
    ).toThrow(/stages\.a: project kind 'notes' offers no task type 'research'/)
    expect(() =>
      registry().register({ ...notes(1), stages: [stage('a', { config: {} })] }),
    ).toThrow(/stages\.a: topic: required/)
  })

  it('refuses a research stage whose config is not a research spec', () => {
    expect(() =>
      registry().register({
        ...research(1),
        stages: [
          stage('a', { taskType: 'research', config: undefined }),
          stage('b', {
            taskType: 'research',
            config: {
              brief: 'x',
              topics: [{ id: 't', title: 'T', questions: [{ id: 'q', question: 'Q?' }] }],
            },
          }),
        ],
      }),
    ).toThrow(/stages\.a: /)
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

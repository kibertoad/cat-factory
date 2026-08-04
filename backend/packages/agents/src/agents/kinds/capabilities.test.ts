import type { McpServerDefinition } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { AgentKindRegistry } from './registry.js'
import {
  bundledSkillToResolved,
  normalizeSkillRefs,
  normalizeToolRefs,
  type BundledSkillDefinition,
} from './capabilities.js'

// The capability declaration seam: a kind names its skills and tool servers by registered id, or
// inline. These pin the resolution rules that decide what an agent actually gets — precedence,
// dedup, and the "report, never throw" contract for an id with no registration (boot validation is
// the loud channel; a dispatch must not fail over a typo it cannot fix).

const SKILL: BundledSkillDefinition = {
  id: 'house-review',
  name: 'house-review',
  description: 'The house review playbook',
  instructions: 'Check the seams first.',
  resources: [{ relPath: 'checklist.md', content: '- seams' }],
}

const SERVER: McpServerDefinition = {
  id: 'issues',
  transport: { kind: 'stdio', command: 'npx', args: ['-y', 'issue-mcp'] },
}

describe('normalizeSkillRefs', () => {
  it('splits registered ids, inline definitions and catalog refs, preserving order', () => {
    const result = normalizeSkillRefs(
      ['house-review', { catalogSkillId: 'src:s:triage' }, { ...SKILL, id: 'inline' }],
      (id) => (id === 'house-review' ? SKILL : undefined),
    )
    expect(result.bundled.map((s) => s.id)).toEqual(['house-review', 'inline'])
    expect(result.catalog).toEqual([{ skillId: 'src:s:triage', optional: false }])
    expect(result.unknown).toEqual([])
  })

  it('reports an unregistered id instead of throwing', () => {
    const result = normalizeSkillRefs(['nope'], () => undefined)
    expect(result.unknown).toEqual(['nope'])
    expect(result.bundled).toEqual([])
  })

  it('dedups by id across sources, keeping the first occurrence', () => {
    const result = normalizeSkillRefs(
      ['house-review', SKILL, { catalogSkillId: 'src:s:x' }, { catalogSkillId: 'src:s:x' }],
      () => SKILL,
    )
    expect(result.bundled).toHaveLength(1)
    expect(result.catalog).toHaveLength(1)
  })

  it('carries the optional flag through', () => {
    const result = normalizeSkillRefs(
      [{ catalogSkillId: 'src:s:x', optional: true }],
      () => undefined,
    )
    expect(result.catalog).toEqual([{ skillId: 'src:s:x', optional: true }])
  })
})

describe('normalizeToolRefs', () => {
  it('resolves registered ids, keeps inline definitions, and reports unknown ids', () => {
    const inline: McpServerDefinition = { ...SERVER, id: 'docs' }
    const result = normalizeToolRefs(['issues', inline, 'nope'], (id) =>
      id === 'issues' ? SERVER : undefined,
    )
    expect(result.servers.map((s) => s.id)).toEqual(['issues', 'docs'])
    expect(result.unknown).toEqual(['nope'])
  })

  it('collapses duplicates by server id', () => {
    const result = normalizeToolRefs(['issues', SERVER], () => SERVER)
    expect(result.servers).toHaveLength(1)
  })
})

describe('bundledSkillToResolved', () => {
  it('always carries resource bodies — a bundled resource is already in memory', () => {
    const resolved = bundledSkillToResolved(SKILL)
    expect(resolved.origin).toBe('bundled')
    expect(resolved.skillId).toBe('house-review')
    // The "reference by repo path, no body" degradation exists only for a catalog FETCH that
    // failed; there is no fetch here, so a bundled resource is never body-less.
    expect(resolved.resources).toEqual([
      { path: 'checklist.md', relPath: 'checklist.md', body: '- seams' },
    ])
  })
})

describe('AgentKindRegistry capabilities', () => {
  it('unions a kind’s own declarations with assignments, own first', () => {
    const registry = new AgentKindRegistry()
    registry.registerSkill(SKILL)
    registry.registerSkill({ ...SKILL, id: 'assigned', name: 'assigned' })
    registry.register({ kind: 'k', systemPrompt: 'p', skills: ['house-review'] })
    registry.assignSkills('k', ['assigned'])
    expect(registry.skillsFor('k').bundled.map((s) => s.id)).toEqual(['house-review', 'assigned'])
  })

  it('assigns tool servers to a BUILT-IN kind without redefining it', () => {
    // This is the seam a deployment uses to give `coder` its issue-tracker MCP server: the kind's
    // prompt, traits and surface stay exactly as shipped.
    const registry = new AgentKindRegistry()
    registry.registerToolServer(SERVER)
    registry.assignToolServers('coder', ['issues'])
    expect(registry.toolServersFor('coder').servers.map((s) => s.id)).toEqual(['issues'])
  })

  it('costs nothing for a kind that declares no capabilities', () => {
    const registry = new AgentKindRegistry()
    expect(registry.skillsFor('coder').bundled).toEqual([])
    expect(registry.toolServersFor('coder').servers).toEqual([])
  })

  it('enumerates registered kinds AND the kinds capabilities were assigned to', () => {
    // The union is what boot validation and the capability-credential checklist walk. `all()` is
    // not it: the recommended attachment path is `assignToolServers('coder', …)`, and no built-in
    // is a registry entry — so an `all()` walk skipped every assigned declaration, which is how a
    // cleartext endpoint on `coder` used to boot clean.
    const registry = new AgentKindRegistry()
    registry.registerToolServer(SERVER)
    registry.registerSkill(SKILL)
    registry.register({ kind: 'auditor', systemPrompt: 'p' })
    registry.assignToolServers('coder', ['issues'])
    registry.assignSkills('ci-fixer', ['house-review'])
    expect([...registry.kindsWithCapabilities()].sort()).toEqual(['auditor', 'ci-fixer', 'coder'])
    expect(registry.all().map((d) => d.kind)).toEqual(['auditor'])
  })

  it('lists a kind once when it is both registered and assigned to', () => {
    const registry = new AgentKindRegistry()
    registry.registerToolServer(SERVER)
    registry.register({ kind: 'auditor', systemPrompt: 'p', toolServers: [SERVER] })
    registry.assignToolServers('auditor', ['issues'])
    expect(registry.kindsWithCapabilities()).toEqual(['auditor'])
  })

  it('a later registration REPOINTS a server an installed package registered', () => {
    const registry = new AgentKindRegistry()
    registry.registerToolServer(SERVER)
    registry.registerToolServer({
      ...SERVER,
      transport: { kind: 'http', url: 'https://internal.example.com/mcp' },
    })
    registry.assignToolServers('coder', ['issues'])
    expect(registry.toolServersFor('coder').servers[0]?.transport.kind).toBe('http')
  })
})

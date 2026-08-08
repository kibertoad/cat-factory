import { describe, it, expect } from 'vitest'
import { PIPELINE_PURPOSES, purposeAllowsAgentCategory } from '@cat-factory/contracts'
import type { AgentKind, BlockStatus, BlockType } from '~/types/domain'
import { narrowAgentPalette } from '~/utils/agentPalette'
import {
  AGENT_ARCHETYPES,
  AGENT_BY_KIND,
  BLOCK_TYPE_META,
  COMPANION_FOR_PRODUCER,
  MODEL_CONFIGURABLE_SYSTEM_KINDS,
  STATUS_META,
  SYSTEM_AGENT_META,
  agentKindMeta,
  blockTypeMeta,
  uid,
} from '~/utils/catalog'

const AGENT_KINDS: AgentKind[] = [
  'requirements-review',
  'clarity-review',
  'requirements-brainstorm',
  'architecture-brainstorm',
  'bug-investigator',
  'pr-reviewer',
  'spike',
  'task-estimator',
  'spec-writer',
  'blueprints',
  'architect',
  'researcher',
  'coder',
  'deployer',
  'tester-api',
  'tester-ui',
  'reviewer',
  'documenter',
  'integrator',
  'architect-companion',
  'spec-companion',
  'doc-reviewer',
  'playwright',
  'mocker',
  'business-documenter',
  'business-reviewer',
  'human-test',
  'visual-confirmation',
  'disposer',
]
const BLOCK_TYPES: BlockType[] = [
  'frontend',
  'service',
  'library',
  'document',
  'api',
  'database',
  'queue',
  'integration',
  'external',
  'environment',
]
const BLOCK_STATUSES: BlockStatus[] = [
  'planned',
  'ready',
  'in_progress',
  'blocked',
  'pr_ready',
  'done',
]

describe('catalog', () => {
  it('indexes every archetype by its kind', () => {
    expect(Object.keys(AGENT_BY_KIND).sort()).toEqual([...AGENT_KINDS].sort())
    for (const a of AGENT_ARCHETYPES) {
      expect(AGENT_BY_KIND[a.kind]).toBe(a)
    }
  })

  it('classifies every built-in kind into a tier', () => {
    // The palette / model-preset surfaces open on `basic`, so a built-in that forgot its tier
    // would silently fall to the DEFAULT (intermediate) and vanish from the default view for
    // no stated reason. Only a deployment-registered kind may leave it to the default.
    for (const a of [...AGENT_ARCHETYPES, ...Object.values(SYSTEM_AGENT_META)]) {
      expect(a.tier, `${a.kind} declares no tier`).toBeDefined()
    }
    // And the everyday delivery loop has to be assemblable without touching the control.
    const basic = AGENT_ARCHETYPES.filter((a) => a.tier === 'basic').map((a) => a.kind)
    expect(basic).toEqual(expect.arrayContaining(['architect', 'coder', 'tester-api']))
  })

  it('leaves every purpose a palette to build from, and every declaration saveable', () => {
    // Two properties over the whole grid rather than a pinned count, which every ordinary
    // addition would break without naming anything.
    //
    // A `purposes` declaration only ever HIDES, so the way to get it wrong is to hide too much:
    // a purpose whose palette reduces to nothing is a dial setting with no way forward, and the
    // widest tier is where that has to be checked because the tier hint is the way out of a thin
    // one. And relevance stays a subset of compatibility per KIND, so a declaration can never
    // offer a step the save gate would then refuse.
    for (const purpose of PIPELINE_PURPOSES) {
      const offered = narrowAgentPalette(AGENT_ARCHETYPES, purpose, 'advanced').offered
      expect(offered.length, `${purpose} offers no agent at all`).toBeGreaterThan(0)
      for (const a of offered) {
        expect(
          !a.category || purposeAllowsAgentCategory(purpose, a.category),
          `${a.kind} is offered to a ${purpose} pipeline its step could not be saved in`,
        ).toBe(true)
      }
    }
  })

  it('never declares an EMPTY `purposes` (which reads as no declaration, not as "nowhere")', () => {
    // `agentPresentationSchema` refuses an empty list at registration, but this catalog is
    // authored in TypeScript and parsed by nothing, so the same guard has to be asserted for the
    // half valibot never sees. Left empty, a kind someone meant to offer NOWHERE is offered
    // everywhere its section is: `purposeSuggestsAgentKind` cannot tell an authored `[]` from a
    // kind that declared nothing at all.
    for (const a of [...AGENT_ARCHETYPES, ...Object.values(SYSTEM_AGENT_META)]) {
      if (!a.purposes) continue
      expect(a.purposes.length, `${a.kind} declares an empty purposes list`).toBeGreaterThan(0)
    }
  })

  it('never shadows a companion producer as a system kind', () => {
    // A companion is never placed directly: the builder renders it as a toggle on its producer
    // step, so a producer that cannot be placed takes its companion out of the builder with it.
    // A producer reaches the palette either statically (AGENT_ARCHETYPES) or from the backend
    // registry — and an entry in SYSTEM_AGENT_META DROPS the registry's copy (see the agents
    // store's `customArchetypes`), which is how `spec-writer` and its `spec-companion` both
    // became unreachable. The shadow is the half this file owns, so it is the half asserted.
    for (const producer of Object.keys(COMPANION_FOR_PRODUCER)) {
      expect(
        producer in SYSTEM_AGENT_META,
        `${producer} has a companion but is shadowed as a system kind, so neither can be placed`,
      ).toBe(false)
    }
  })

  it('resolves every kind the Model Defaults panel lists beside the palette', () => {
    // The list is spelled as kind strings indexed into SYSTEM_AGENT_META through a non-null
    // assertion, so a kind that MOVES to the palette (or is renamed) leaves an `undefined` in
    // the array rather than a type error, and the panel renders a blank row it cannot pin a
    // model on. Assert the relation the assertion claims.
    for (const entry of MODEL_CONFIGURABLE_SYSTEM_KINDS) {
      expect(entry, 'MODEL_CONFIGURABLE_SYSTEM_KINDS names a kind with no metadata').toBeDefined()
      expect(entry.kind).toEqual(expect.any(String))
    }
    // And nothing is offered twice: a palette archetype is already listed by the panel, so a
    // kind appearing in both would render a duplicate row.
    const palette = new Set(AGENT_ARCHETYPES.map((a) => a.kind))
    for (const entry of MODEL_CONFIGURABLE_SYSTEM_KINDS) {
      expect(palette.has(entry.kind), `${entry.kind} is listed twice in Model Defaults`).toBe(false)
    }
  })

  it('resolves usable metadata for every kind via agentKindMeta', () => {
    // Palette archetypes resolve to their own entry.
    for (const a of AGENT_ARCHETYPES) {
      expect(agentKindMeta(a.kind)).toBe(a)
    }
    // Engine system kinds (present in seeded pipelines but not the palette) resolve
    // to their system metadata rather than blowing up an undefined access.
    for (const kind of [
      'conflicts',
      'conflict-resolver',
      'ci',
      'ci-fixer',
      'merger',
      'post-release-health',
    ]) {
      expect(agentKindMeta(kind)).toBe(SYSTEM_AGENT_META[kind])
      expect(agentKindMeta(kind).icon).toEqual(expect.any(String))
    }
    // An unknown/custom kind still returns a usable fallback (never undefined).
    const unknown = agentKindMeta('totally-made-up')
    expect(unknown).toMatchObject({
      label: expect.any(String),
      icon: expect.any(String),
      color: expect.any(String),
    })
  })

  it('provides metadata for every block type', () => {
    for (const t of BLOCK_TYPES) {
      expect(BLOCK_TYPE_META[t]).toMatchObject({
        label: expect.any(String),
        icon: expect.any(String),
        accent: expect.any(String),
      })
    }
  })

  it('blockTypeMeta returns a usable fallback for an unknown block type', () => {
    expect(blockTypeMeta('totally-made-up' as BlockType)).toMatchObject({
      label: expect.any(String),
      icon: expect.any(String),
      accent: expect.any(String),
    })
  })

  it('provides metadata for every block status', () => {
    for (const s of BLOCK_STATUSES) {
      expect(STATUS_META[s]).toMatchObject({
        label: expect.any(String),
        color: expect.any(String),
        chip: expect.any(String),
        icon: expect.any(String),
      })
    }
  })

  it('uid produces prefixed, unique-ish ids', () => {
    expect(uid('blk')).toMatch(/^blk_[a-z0-9]+$/)
    expect(uid('blk')).not.toBe(uid('blk'))
  })
})

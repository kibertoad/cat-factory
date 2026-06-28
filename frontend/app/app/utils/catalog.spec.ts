import { describe, it, expect } from 'vitest'
import type { AgentKind, BlockStatus, BlockType } from '~/types/domain'
import {
  AGENT_ARCHETYPES,
  AGENT_BY_KIND,
  BLOCK_TYPE_META,
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
  'task-estimator',
  'architect',
  'researcher',
  'coder',
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
]
const BLOCK_TYPES: BlockType[] = [
  'frontend',
  'service',
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

  it('resolves usable metadata for every kind via agentKindMeta', () => {
    // Palette archetypes resolve to their own entry.
    for (const a of AGENT_ARCHETYPES) {
      expect(agentKindMeta(a.kind)).toBe(a)
    }
    // Engine system kinds (present in seeded pipelines but not the palette) resolve
    // to their system metadata rather than blowing up an undefined access.
    for (const kind of [
      'spec-writer',
      'blueprints',
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

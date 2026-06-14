import { describe, it, expect } from 'vitest'
import type { AgentKind, BlockStatus, BlockType } from '~/types/domain'
import {
  AGENT_ARCHETYPES,
  AGENT_BY_KIND,
  BLOCK_TYPE_META,
  STATUS_META,
  DEFAULT_CONFIDENCE_THRESHOLD,
  uid,
} from '~/utils/catalog'

const AGENT_KINDS: AgentKind[] = [
  'architect',
  'researcher',
  'coder',
  'tester',
  'reviewer',
  'documenter',
  'integrator',
  'acceptance',
  'playwright',
  'mocker',
]
const BLOCK_TYPES: BlockType[] = [
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
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

  it('provides metadata for every block type', () => {
    for (const t of BLOCK_TYPES) {
      expect(BLOCK_TYPE_META[t]).toMatchObject({
        label: expect.any(String),
        icon: expect.any(String),
        accent: expect.any(String),
      })
    }
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

  it('keeps the default confidence threshold within 0..1', () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBeGreaterThan(0)
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1)
  })

  it('uid produces prefixed, unique-ish ids', () => {
    expect(uid('blk')).toMatch(/^blk_[a-z0-9]+$/)
    expect(uid('blk')).not.toBe(uid('blk'))
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentArchetype } from '~/types/domain'
import { filterByAgentTier, filterByAgentTierKeeping, isAgentTier } from '~/utils/agentTier'

const archetype = (kind: string, tier?: AgentArchetype['tier']): AgentArchetype => ({
  kind: kind as AgentArchetype['kind'],
  label: kind,
  icon: 'i-lucide-bot',
  color: '#fff',
  description: kind,
  ...(tier ? { tier } : {}),
})

const CATALOG: AgentArchetype[] = [
  archetype('coder', 'basic'),
  archetype('researcher', 'intermediate'),
  archetype('mocker', 'advanced'),
  // A deployment-registered kind that declared no tier.
  archetype('acme-auditor'),
]

describe('filterByAgentTier', () => {
  it('shows only the basic kinds at the default level', () => {
    expect(filterByAgentTier(CATALOG, 'basic').map((a) => a.kind)).toEqual(['coder'])
  })

  it('accumulates the levels, with advanced showing the whole catalog', () => {
    expect(filterByAgentTier(CATALOG, 'intermediate').map((a) => a.kind)).toEqual([
      'coder',
      'researcher',
      // An undeclared tier defaults to intermediate, so it appears here.
      'acme-auditor',
    ])
    expect(filterByAgentTier(CATALOG, 'advanced')).toHaveLength(CATALOG.length)
  })
})

describe('filterByAgentTierKeeping', () => {
  it('keeps a pinned kind the tier would otherwise hide, in catalog order', () => {
    const kept = filterByAgentTierKeeping(CATALOG, 'basic', (a) => a.kind === 'mocker')
    expect(kept.map((a) => a.kind)).toEqual(['coder', 'mocker'])
  })

  it('does not duplicate a pinned kind the tier already shows', () => {
    const kept = filterByAgentTierKeeping(CATALOG, 'advanced', () => true)
    expect(kept.map((a) => a.kind)).toEqual(CATALOG.map((a) => a.kind))
  })
})

describe('isAgentTier', () => {
  it('accepts the known tiers and rejects anything else', () => {
    expect(isAgentTier('basic')).toBe(true)
    expect(isAgentTier('advanced')).toBe(true)
    // A persisted blob from an older build, or a hand-edited one.
    expect(isAgentTier('expert')).toBe(false)
    expect(isAgentTier(undefined)).toBe(false)
    expect(isAgentTier(2)).toBe(false)
  })
})

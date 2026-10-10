import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  AGENT_TIERS,
  DEFAULT_AGENT_TIER,
  agentPresentationSchema,
  agentTierVisibleAt,
} from './agent-presentation.js'

describe('agentTierVisibleAt', () => {
  it('is cumulative — a level shows its own tier and every tier below it', () => {
    expect(AGENT_TIERS.filter((t) => agentTierVisibleAt(t, 'basic'))).toEqual(['basic'])
    expect(AGENT_TIERS.filter((t) => agentTierVisibleAt(t, 'intermediate'))).toEqual([
      'basic',
      'intermediate',
    ])
    // `advanced` is the widest level: it shows the whole catalog.
    expect(AGENT_TIERS.filter((t) => agentTierVisibleAt(t, 'advanced'))).toEqual([...AGENT_TIERS])
  })

  it('treats an undeclared tier as the default tier', () => {
    for (const level of AGENT_TIERS) {
      expect(agentTierVisibleAt(undefined, level)).toBe(
        agentTierVisibleAt(DEFAULT_AGENT_TIER, level),
      )
      expect(agentTierVisibleAt(null, level)).toBe(agentTierVisibleAt(DEFAULT_AGENT_TIER, level))
    }
    // Which means it is hidden from the default (`basic`) view but shown one level up.
    expect(agentTierVisibleAt(undefined, 'basic')).toBe(false)
    expect(agentTierVisibleAt(undefined, 'intermediate')).toBe(true)
  })
})

describe('agentPresentationSchema', () => {
  const base = {
    label: 'Security Auditor',
    icon: 'i-lucide-shield',
    color: '#f00',
    description: 'Audits.',
  }

  it('accepts a declared tier and leaves it absent when omitted', () => {
    expect(v.parse(agentPresentationSchema, { ...base, tier: 'basic' }).tier).toBe('basic')
    expect(v.parse(agentPresentationSchema, base).tier).toBeUndefined()
  })

  it('rejects a tier outside the vocabulary', () => {
    expect(() => v.parse(agentPresentationSchema, { ...base, tier: 'expert' })).toThrow()
  })

  it('accepts a declared purpose list and leaves it absent when omitted', () => {
    expect(v.parse(agentPresentationSchema, { ...base, purposes: ['document'] }).purposes).toEqual([
      'document',
    ])
    expect(v.parse(agentPresentationSchema, base).purposes).toBeUndefined()
  })

  it('rejects an EMPTY purpose list, which the palette could not tell from declaring none', () => {
    // `purposeSuggestsAgentKind` reads both as "the category alone decides", so an empty list
    // offers the kind at every purpose its section admits. That is the opposite of what an author
    // typing it means, and registration is the last place the two are still distinguishable.
    expect(() => v.parse(agentPresentationSchema, { ...base, purposes: [] })).toThrow()
  })

  it('rejects a purpose outside the vocabulary', () => {
    expect(() => v.parse(agentPresentationSchema, { ...base, purposes: ['deploy'] })).toThrow()
  })
})

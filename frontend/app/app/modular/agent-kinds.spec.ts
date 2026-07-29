import { describe, expect, it } from 'vitest'
import { customKindToArchetype } from './agent-kinds'
import type { AgentKind, CustomAgentKind } from '~/types/domain'

const kind = (
  over: Partial<CustomAgentKind['presentation']> = {},
  kindId = 'acme-audit',
): CustomAgentKind => ({
  kind: kindId as AgentKind,
  container: true,
  presentation: {
    label: 'Audit',
    icon: 'i-lucide-shield',
    color: '#fff',
    description: 'd',
    ...over,
  },
})

describe('customKindToArchetype', () => {
  it('projects presentation onto the display archetype', () => {
    expect(customKindToArchetype(kind())).toEqual({
      kind: 'acme-audit',
      label: 'Audit',
      icon: 'i-lucide-shield',
      color: '#fff',
      description: 'd',
    })
  })

  it('carries category, tier and resultView through when present', () => {
    const a = customKindToArchetype(
      kind({ category: 'review', tier: 'basic', resultView: 'acme:audit' }),
    )
    expect(a.category).toBe('review')
    expect(a.tier).toBe('basic')
    expect(a.resultView).toBe('acme:audit')
  })

  it('omits category/tier/resultView when absent (no undefined keys)', () => {
    const a = customKindToArchetype(kind())
    expect('category' in a).toBe(false)
    // Left UNSET rather than stamped with the default, so the fallback stays in one place
    // (`agentTierVisibleAt`) instead of being forked into this projection.
    expect('tier' in a).toBe(false)
    expect('resultView' in a).toBe(false)
  })
})

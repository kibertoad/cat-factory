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

  it('carries category and resultView through when present', () => {
    const a = customKindToArchetype(kind({ category: 'review', resultView: 'acme:audit' }))
    expect(a.category).toBe('review')
    expect(a.resultView).toBe('acme:audit')
  })

  it('omits category/resultView when absent (no undefined keys)', () => {
    const a = customKindToArchetype(kind())
    expect('category' in a).toBe(false)
    expect('resultView' in a).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  buildAgentCapabilitiesManifest,
  customKindToArchetype,
  WORKSPACE_CAPABILITIES_MANIFEST_ID,
} from './agent-kinds'
import type { AgentKind, CustomAgentKind } from '~/types/domain'

const kind = (over: Partial<CustomAgentKind['presentation']> = {}): CustomAgentKind => ({
  kind: 'acme-audit' as AgentKind,
  container: true,
  presentation: {
    label: 'Audit',
    icon: 'i-lucide-shield',
    color: '#fff',
    description: 'd',
    ...over,
  },
})

describe('buildAgentCapabilitiesManifest', () => {
  it('models the snapshot kinds as one remote capability manifest carrying the agentKinds slot', () => {
    const kinds = [kind(), kind()]
    const manifest = buildAgentCapabilitiesManifest(kinds)
    expect(manifest.id).toBe(WORKSPACE_CAPABILITIES_MANIFEST_ID)
    expect(manifest.version).toBe('1')
    expect(manifest.slots?.agentKinds).toEqual(kinds)
  })

  it('copies the input (no aliasing of the caller array)', () => {
    const kinds = [kind()]
    const manifest = buildAgentCapabilitiesManifest(kinds)
    kinds.push(kind())
    expect(manifest.slots?.agentKinds).toHaveLength(1)
  })
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

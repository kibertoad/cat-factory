import { describe, expect, it } from 'vitest'
import {
  buildAgentCapabilitiesManifest,
  capabilitiesManifestVersion,
  customKindToArchetype,
  WORKSPACE_CAPABILITIES_MANIFEST_ID,
} from './agent-kinds'
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

describe('buildAgentCapabilitiesManifest', () => {
  it('models the snapshot kinds as one remote capability manifest carrying the agentKinds slot', () => {
    const kinds = [kind(), kind()]
    const manifest = buildAgentCapabilitiesManifest(kinds)
    expect(manifest.id).toBe(WORKSPACE_CAPABILITIES_MANIFEST_ID)
    expect(manifest.slots?.agentKinds).toEqual(kinds)
  })

  it('copies the input (no aliasing of the caller array)', () => {
    const kinds = [kind()]
    const manifest = buildAgentCapabilitiesManifest(kinds)
    kinds.push(kind())
    expect(manifest.slots?.agentKinds).toHaveLength(1)
  })

  it('derives an identical version for identical content (so an unchanged re-hydrate no-ops)', () => {
    // A fresh, structurally-equal kinds array (a new snapshot re-delivering the same kinds)
    // must produce the same version — that's what lets `hydrateCustomKinds` skip the swap.
    expect(buildAgentCapabilitiesManifest([kind()]).version).toBe(
      buildAgentCapabilitiesManifest([kind()]).version,
    )
  })

  it('changes the version when a display/pairing field or the kind set differs', () => {
    const base = capabilitiesManifestVersion([kind()])
    expect(capabilitiesManifestVersion([kind({ label: 'Renamed' })])).not.toBe(base)
    expect(capabilitiesManifestVersion([kind({ resultView: 'acme:audit' })])).not.toBe(base)
    expect(capabilitiesManifestVersion([kind({}, 'acme-other')])).not.toBe(base)
    expect(capabilitiesManifestVersion([kind(), kind({}, 'acme-two')])).not.toBe(base)
    expect(capabilitiesManifestVersion([])).not.toBe(base)
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

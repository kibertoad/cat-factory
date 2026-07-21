import { describe, expect, it } from 'vitest'
import { useAgentsStore } from './agents'
import { buildWorkspaceCapabilitiesManifest } from '~/modular/capabilities'
import {
  __resetCustomAgentKindMetaForTest,
  agentKindMeta,
  AGENT_ARCHETYPES,
  isKnownAgentKind,
} from '~/utils/catalog'
import type { AgentKind, CustomAgentKind } from '~/types/domain'

const backendKind = (
  kind: string,
  over: Partial<CustomAgentKind['presentation']> = {},
): CustomAgentKind => ({
  kind: kind as AgentKind,
  container: true,
  presentation: {
    label: `L:${kind}`,
    icon: 'i-lucide-shield',
    color: '#abc',
    description: 'd',
    ...over,
  },
})

/** Hydrate the store's backend-manifest half with `kinds` (via the shared capability manifest). */
const hydrate = (agents: ReturnType<typeof useAgentsStore>, kinds: CustomAgentKind[]): void => {
  agents.hydrateCapabilities(buildWorkspaceCapabilitiesManifest(kinds, []))
}

describe('agents store — custom-kind catalog (slice 2)', () => {
  it('exposes only the built-in archetypes before any custom kind is hydrated', () => {
    const agents = useAgentsStore()
    expect(agents.archetypes).toHaveLength(AGENT_ARCHETYPES.length)
    expect(agents.customArchetypes).toEqual([])
  })

  it('folds a backend remote-manifest custom kind into the palette + the pure-util projection', () => {
    __resetCustomAgentKindMetaForTest()
    const agents = useAgentsStore()
    // Before hydrate the pure-util lookups don't know the kind.
    expect(isKnownAgentKind('acme-audit')).toBe(false)
    expect(agentKindMeta('acme-audit').label).toBe('Agent') // generic fallback

    hydrate(agents, [backendKind('acme-audit', { category: 'review', resultView: 'acme:audit' })])

    // Palette + kind lookup both see it now (sync-flush projection — no tick needed).
    expect(agents.archetypes.some((a) => a.kind === 'acme-audit')).toBe(true)
    expect(isKnownAgentKind('acme-audit')).toBe(true)
    const meta = agentKindMeta('acme-audit')
    expect(meta.label).toBe('L:acme-audit')
    expect(meta.resultView).toBe('acme:audit')
    expect(meta.category).toBe('review')
  })

  it('never lets a custom kind shadow a built-in kind', () => {
    const agents = useAgentsStore()
    hydrate(agents, [backendKind('coder', { label: 'Evil Coder' })])
    // `coder` is a built-in; the custom entry is dropped, the built-in wins.
    expect(agents.customArchetypes.some((a) => a.kind === 'coder')).toBe(false)
    expect(agentKindMeta('coder').label).not.toBe('Evil Coder')
  })

  it('merges CODE-shipped consumer kinds with BACKEND manifest kinds, de-duplicated', () => {
    const agents = useAgentsStore()
    agents.registerConsumerKinds([backendKind('acme-consumer')])
    hydrate(agents, [backendKind('acme-backend'), backendKind('acme-consumer')])
    const kinds = agents.customArchetypes.map((a) => a.kind)
    expect(kinds).toContain('acme-consumer')
    expect(kinds).toContain('acme-backend')
    // consumer + backend both name `acme-consumer`; it appears once (consumer-slot first).
    expect(kinds.filter((k) => k === 'acme-consumer')).toHaveLength(1)
  })

  it('no-ops a re-hydrate of identical content (stable projection, content-versioned manifest)', () => {
    const agents = useAgentsStore()
    hydrate(agents, [backendKind('acme-x', { resultView: 'acme:x' })])
    const first = agents.customArchetypes
    // A new snapshot re-delivering structurally-equal kinds (fresh objects) must not
    // recompute the merged catalog — the content-derived manifest version is unchanged, so
    // `hydrateCustomKinds` skips the swap and the computed keeps its cached identity.
    hydrate(agents, [backendKind('acme-x', { resultView: 'acme:x' })])
    expect(agents.customArchetypes).toBe(first)
  })

  it('swaps the backend catalog wholesale on re-hydrate (per-workspace manifest)', () => {
    const agents = useAgentsStore()
    hydrate(agents, [backendKind('ws1-kind')])
    expect(agents.customArchetypes.some((a) => a.kind === 'ws1-kind')).toBe(true)
    hydrate(agents, [backendKind('ws2-kind')])
    expect(agents.customArchetypes.some((a) => a.kind === 'ws1-kind')).toBe(false)
    expect(agents.customArchetypes.some((a) => a.kind === 'ws2-kind')).toBe(true)
    expect(isKnownAgentKind('ws1-kind')).toBe(false)
  })

  it('addAgent registers an in-UI prototype without touching the built-in catalog', () => {
    const agents = useAgentsStore()
    const created = agents.addAgent({ label: 'My Agent' })
    expect(agents.archetypes.some((a) => a.kind === created.kind)).toBe(true)
    expect(created.category).toBeUndefined() // lands in the palette "custom" bucket
    expect(agentKindMeta(created.kind).label).toBe('My Agent')
  })
})

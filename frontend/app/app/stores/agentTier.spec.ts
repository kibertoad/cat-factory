import { describe, it, expect } from 'vitest'
import type { AgentTier } from '~/types/domain'
import { useAgentTierStore } from '~/stores/agentTier'

describe('agentTier store', () => {
  it('opens on the everyday-loop tier and records a widening', () => {
    const store = useAgentTierStore()
    expect(store.tier).toBe('basic')
    expect(store.showsAll).toBe(false)

    store.setTier('advanced')
    expect(store.tier).toBe('advanced')
    // The widest level is the "show everything" setting the surfaces advertise.
    expect(store.showsAll).toBe(true)
  })

  it('falls back to the default when the persisted value is not a known tier', () => {
    const store = useAgentTierStore()
    // What a blob written by an older build (or hand-edited) looks like coming back in. A
    // catalog filtered on an unknown level would list nothing at all, so this must not pass through.
    store.storedTier = 'expert' as AgentTier
    expect(store.tier).toBe('basic')
  })
})

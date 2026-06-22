import { describe, it, expect } from 'vitest'
import { resolveIndividualVendors } from './individualVendors.logic.js'

// The personal-credential gate must only fire for an individual-usage subscription
// model (Claude / GLM / Codex). A block pinned to a non-subscription model (Cloudflare /
// Bedrock / a direct provider) must NOT be gated on a personal password — even when the
// workspace per-kind default is itself an individual-usage model — because that pin wins
// for every step at dispatch. These lock that precedence so a regression re-prompts.

// Real catalog ids: `cloudflare-llama` (Cloudflare, non-individual), `claude-opus`
// (Claude subscription, individual), `glm` (GLM subscription, individual).

describe('resolveIndividualVendors', () => {
  it('returns no vendor for a block pinned to a Cloudflare model', async () => {
    const vendors = await resolveIndividualVendors('cloudflare-llama', ['coder'], async () => 'claude-opus')
    expect(vendors).toEqual([])
  })

  it('does NOT consult workspace defaults when the pin is a resolvable non-subscription model', async () => {
    let consulted = false
    const vendors = await resolveIndividualVendors('cloudflare-llama', ['coder', 'reviewer'], async () => {
      consulted = true
      return 'claude-opus'
    })
    expect(consulted).toBe(false)
    expect(vendors).toEqual([])
  })

  it('gates on the pinned vendor for an individual-usage model', async () => {
    const vendors = await resolveIndividualVendors('claude-opus', ['coder'], async () => 'cloudflare-llama')
    expect(vendors).toEqual(['claude'])
  })

  it('falls through to workspace defaults when there is no pin', async () => {
    const vendors = await resolveIndividualVendors(undefined, ['coder'], async () => 'claude-opus')
    expect(vendors).toEqual(['claude'])
  })

  it('falls through a stale/unknown pin to the workspace defaults', async () => {
    // glm is dual-mode, so the gate fires only when the user has their own glm
    // subscription — stub `hasPersonalSubscription` true so it resolves to the vendor.
    const vendors = await resolveIndividualVendors('gone-stale', ['coder'], async () => 'glm', () => true)
    expect(vendors).toEqual(['glm'])
  })

  it('returns no vendor when an unpinned run resolves only to non-subscription defaults', async () => {
    const vendors = await resolveIndividualVendors(undefined, ['coder'], async () => 'cloudflare-llama')
    expect(vendors).toEqual([])
  })

  it('dedupes vendors across kinds and skips kinds with a non-individual default', async () => {
    const byKind: Record<string, string> = {
      coder: 'claude-opus',
      reviewer: 'claude-sonnet',
      mocker: 'cloudflare-llama',
    }
    const vendors = await resolveIndividualVendors(undefined, ['coder', 'reviewer', 'mocker'], async (kind) => byKind[kind])
    expect(vendors).toEqual(['claude'])
  })

  it('returns no vendor when no default resolver is wired', async () => {
    const vendors = await resolveIndividualVendors(undefined, ['coder'], undefined)
    expect(vendors).toEqual([])
  })
})

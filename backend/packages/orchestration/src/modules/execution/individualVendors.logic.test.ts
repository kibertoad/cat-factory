import { describe, it, expect } from 'vitest'
import type { SubscriptionVendor } from '@cat-factory/kernel'
import { resolveIndividualVendors } from './individualVendors.logic.js'

// The personal-credential gate must prompt for a password EXACTLY when dispatch will
// lease a personal subscription, and never otherwise. Catalog ids used below:
//   cloudflare-llama — Cloudflare, non-subscription
//   glm              — dual-mode (Cloudflare base + individual GLM subscription)
//   claude-opus      — subscription-only, individual (Claude)
//   gpt-5.5          — subscription-only, individual (Codex)
//   kimi             — dual-mode, POOLABLE (never a personal credential)

const noSubs = (): boolean => false
const hasGlm = (v: SubscriptionVendor): boolean => v === 'glm'

describe('resolveIndividualVendors', () => {
  it('returns no vendor for a block pinned to a Cloudflare model', async () => {
    expect(await resolveIndividualVendors('cloudflare-llama', ['coder'], async () => 'claude-opus', noSubs)).toEqual([])
  })

  it('does NOT consult workspace defaults when the pin is a resolvable non-subscription model', async () => {
    let consulted = false
    const vendors = await resolveIndividualVendors('cloudflare-llama', ['coder'], async () => {
      consulted = true
      return 'claude-opus'
    }, noSubs)
    expect(consulted).toBe(false)
    expect(vendors).toEqual([])
  })

  it('gates a subscription-only individual model (Claude) regardless of personal subs', async () => {
    expect(await resolveIndividualVendors('claude-opus', ['coder'], async () => undefined, noSubs)).toEqual(['claude'])
  })

  it('gates a subscription-only individual model (Codex)', async () => {
    expect(await resolveIndividualVendors('gpt-5.5', ['coder'], async () => undefined, noSubs)).toEqual(['codex'])
  })

  // The headline case: GLM is dual-mode. A user WITHOUT a personal GLM subscription runs
  // it on the Cloudflare base, so no password is requested.
  it('does NOT gate dual-mode GLM when the user has no personal subscription', async () => {
    expect(await resolveIndividualVendors('glm', ['coder'], async () => undefined, noSubs)).toEqual([])
  })

  // A user WITH a personal GLM subscription runs it on their plan, so the gate fires.
  it('gates dual-mode GLM when the user has a personal subscription', async () => {
    expect(await resolveIndividualVendors('glm', ['coder'], async () => undefined, hasGlm)).toEqual(['glm'])
  })

  it('never gates a dual-mode POOLABLE model (Kimi), even with a stray predicate', async () => {
    expect(await resolveIndividualVendors('kimi', ['coder'], async () => undefined, () => true)).toEqual([])
  })

  it('falls through to workspace defaults when there is no pin', async () => {
    expect(await resolveIndividualVendors(undefined, ['coder'], async () => 'claude-opus', noSubs)).toEqual(['claude'])
  })

  it('gates an unpinned run whose GLM default the user subscribes to', async () => {
    expect(await resolveIndividualVendors(undefined, ['coder'], async () => 'glm', hasGlm)).toEqual(['glm'])
  })

  it('does NOT gate an unpinned GLM default for a non-subscriber', async () => {
    expect(await resolveIndividualVendors(undefined, ['coder'], async () => 'glm', noSubs)).toEqual([])
  })

  it('falls through a stale/unknown pin to the workspace defaults', async () => {
    expect(await resolveIndividualVendors('gone-stale', ['coder'], async () => 'claude-opus', noSubs)).toEqual(['claude'])
  })

  it('dedupes vendors across kinds and skips non-credential defaults', async () => {
    const byKind: Record<string, string> = {
      coder: 'claude-opus',
      reviewer: 'claude-sonnet',
      mocker: 'cloudflare-llama',
    }
    const vendors = await resolveIndividualVendors(undefined, ['coder', 'reviewer', 'mocker'], async (k) => byKind[k], noSubs)
    expect(vendors).toEqual(['claude'])
  })

  it('returns no vendor when no default resolver is wired', async () => {
    expect(await resolveIndividualVendors(undefined, ['coder'], undefined, noSubs)).toEqual([])
  })
})

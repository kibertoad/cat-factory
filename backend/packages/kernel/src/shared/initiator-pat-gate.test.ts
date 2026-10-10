import { describe, expect, it, vi } from 'vitest'
import { createInitiatorPatGate, type InitiatorPatAccountTier } from './initiator-pat-gate.js'
import { DEFAULT_WORKSPACE_SETTINGS } from '../domain/catalog.js'
import type { WorkspaceSettings } from '../domain/types.js'
import type { WorkspaceSettingsRepository } from '../ports/workspace-settings-repositories.js'

// The two-tier `allowInitiatorPat` policy. What is under test is the ASYMMETRY between the
// tiers: an account admin's refusal must be out of reach of a workspace admin, because the
// control exists precisely for the case where someone with workspace rights re-widens what the
// operator scoped. The mirror property matters just as much — an account with no opinion must
// leave the workspace alone, since a personal token is the right credential for someone adopting
// cat-factory alone inside an org that has not (see `backend/docs/security-model.md`).

function settingsRepo(allowInitiatorPat: boolean): WorkspaceSettingsRepository {
  return {
    get: async (): Promise<WorkspaceSettings> => ({
      ...DEFAULT_WORKSPACE_SETTINGS,
      allowInitiatorPat,
    }),
  } as unknown as WorkspaceSettingsRepository
}

/** An account tier answering `allow` for every account, recording what it was asked. */
function accountTier(allow: boolean | undefined, accountId: string | null = 'acc_1') {
  const readAllowInitiatorPat = vi.fn(async () => allow)
  const tier: InitiatorPatAccountTier = {
    resolveAccountId: async () => accountId,
    readAllowInitiatorPat,
  }
  return { tier, readAllowInitiatorPat }
}

describe('createInitiatorPatGate', () => {
  it('permits when no settings store is wired at all', async () => {
    // A minimal container / test build has no stored opt-out to honour, so the preference
    // applies — the pre-existing behaviour.
    const gate = createInitiatorPatGate({})
    expect(await gate('ws_1')).toBe(true)
  })

  it('honours the workspace switch when no account tier is wired', async () => {
    // Plain local mode: single-user adoption, no account settings. The workspace decides alone.
    expect(await createInitiatorPatGate({ repository: settingsRepo(true) })('ws_1')).toBe(true)
    expect(await createInitiatorPatGate({ repository: settingsRepo(false) })('ws_1')).toBe(false)
  })

  it('leaves the workspace alone when the account expresses no opinion', async () => {
    // The default for every existing account, and the one that keeps a personal token viable
    // for someone adopting cat-factory alone inside an org that has not adopted it.
    const { tier } = accountTier(undefined)
    const gate = createInitiatorPatGate({ repository: settingsRepo(true), account: tier })
    expect(await gate('ws_1')).toBe(true)
  })

  it('lets an account that permits it defer to a workspace that refuses', async () => {
    // The account sets a FLOOR, not a mandate: permitting does not override a board that has
    // decided otherwise for itself.
    const { tier } = accountTier(true)
    const gate = createInitiatorPatGate({ repository: settingsRepo(false), account: tier })
    expect(await gate('ws_1')).toBe(false)
  })

  it('OVERRIDES a permissive workspace when the account forbids it', async () => {
    // The property the whole tier exists for: a workspace admin cannot re-widen the blast
    // radius the account admin closed.
    const { tier } = accountTier(false)
    const gate = createInitiatorPatGate({ repository: settingsRepo(true), account: tier })
    expect(await gate('ws_1')).toBe(false)
  })

  it('does not read the workspace row once the account has refused', async () => {
    // No workspace answer could re-permit it, so the query would only cost a round trip to
    // reach the same verdict — and on a mothership node that is a network hop.
    const get = vi.fn(async () => ({ ...DEFAULT_WORKSPACE_SETTINGS, allowInitiatorPat: true }))
    const { tier } = accountTier(false)
    const gate = createInitiatorPatGate({
      repository: { get } as unknown as WorkspaceSettingsRepository,
      account: tier,
    })

    expect(await gate('ws_1')).toBe(false)
    expect(get).not.toHaveBeenCalled()
  })

  it('skips the account read entirely for a board under no account', async () => {
    const { tier, readAllowInitiatorPat } = accountTier(false, null)
    const gate = createInitiatorPatGate({ repository: settingsRepo(true), account: tier })

    expect(await gate('ws_1')).toBe(true)
    expect(readAllowInitiatorPat).not.toHaveBeenCalled()
  })

  it('propagates a failed account read rather than defaulting to permitted', async () => {
    // The gate deliberately does not catch: `createResolveRunInitiatorToken` fails CLOSED on a
    // throw, and an unreadable policy must not read as permission to widen a run's credential.
    const gate = createInitiatorPatGate({
      repository: settingsRepo(true),
      account: {
        resolveAccountId: async () => 'acc_1',
        readAllowInitiatorPat: async () => {
          throw new Error('account settings unreadable')
        },
      },
    })

    await expect(gate('ws_1')).rejects.toThrow('account settings unreadable')
  })
})

import type { PersonalSubscriptionService, PublicApiKeyAuth } from '@cat-factory/integrations'
import { CredentialRequiredError } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { keyInitiatorRole } from '../src/http/runAdmission.js'
import { refreshRunActivation } from '../src/modules/providers/personalCredentialGate.js'
import {
  individualModelUnsupported,
  personalUnlockFor,
  unlockIsUnavailable,
} from '../src/modules/publicApi/personalUnlock.js'

// How a KEY-authenticated call reaches an individual-usage (personal) subscription — the decisions
// that admission is made of, driven without a database.
//
// The behaviour under test is authorization, so what is worth pinning is not the prose of a refusal
// but the three judgements the surface makes and could plausibly get wrong in opposite directions:
// WHICH refusal a caller gets (a 428 they can answer, or a flat 409 they cannot), WHOSE policy the
// run is admitted under, and WHEN answering a park has to re-derive the credential at all.

const BOUND_USER = 'usr_7'

const auth = (actsAsUserId: string | null): PublicApiKeyAuth => ({
  keyId: 'pak_1',
  accountId: 'acc_1',
  workspaceId: 'ws_1',
  scope: 'write',
  label: 'operator',
  externalIdentity: null,
  actsAsUserId,
  // Provenance, never an authorization input: an unbound key names its minter here and still may
  // not unlock that person's subscription, which is what the `individual_model_unsupported` case
  // below pins.
  createdByUserId: BOUND_USER,
  createdAt: 1_700_000_000_000,
})

/**
 * A REAL request context carrying just the one header these helpers read, rather than a stub with a
 * `header()` function: the lookup is case-insensitive in Hono and exact in a stub, so a stub would
 * pass for a deployment whose clients send the header in any other casing.
 */
async function contextWith(headers: Record<string, string> = {}) {
  const app = new Hono<AppEnv>()
  let captured: Parameters<typeof personalUnlockFor>[0] | undefined
  app.onError(handleError)
  app.get('/', (c) => {
    captured = c
    return c.body(null, 204)
  })
  await app.request('/', { headers })
  if (!captured) throw new Error('the probe route did not run')
  return captured
}

describe('what a key-authenticated call may unlock', () => {
  it('reads the bound user and the password as one answer', async () => {
    const c = await contextWith({ 'X-Personal-Password': 'hunter2' })
    expect(personalUnlockFor(c, auth(BOUND_USER))).toEqual({
      user: { id: BOUND_USER },
      password: 'hunter2',
    })
  })

  it('resolves neither half for an unbound key, even when a password is sent', async () => {
    // The password alone must never establish an identity: it proves consent to unlock a credential
    // the BINDING names, and an unbound key names none. Without this, a caller could send any
    // password and have the gate look for a subscription belonging to nobody.
    const c = await contextWith({ 'X-Personal-Password': 'hunter2' })
    expect(personalUnlockFor(c, auth(null)).user).toBeUndefined()
  })

  it('flattens the refusal only where no password could help', async () => {
    const bound = await contextWith({})
    // A bound key CAN act on a 428 (supply or correct the password), so flattening it to the 409
    // would throw away the vendor and reason that make it actionable.
    expect(unlockIsUnavailable(personalUnlockFor(bound, auth(BOUND_USER)))).toBe(false)
    expect(unlockIsUnavailable(personalUnlockFor(bound, auth(null)))).toBe(true)
  })

  it('offers the app as a remedy for a task and not for a job, and one code for both', () => {
    // The `code` is the machine-readable half and must not differ by surface; the remedy tail must,
    // because a headless job has no board affordance to fall back on.
    expect(individualModelUnsupported('task').code).toBe(individualModelUnsupported('job').code)
    expect(individualModelUnsupported('task').message).toContain('from the app')
    expect(individualModelUnsupported('job').message).not.toContain('from the app')
    expect(individualModelUnsupported('job').message).toContain('X-Personal-Password')
  })
})

/**
 * A container answering just the membership reads `keyInitiatorRole` makes: a RESTRICTED board in an
 * account the user belongs to, so the member row is the sole grant and the fixture's role is exactly
 * what `resolveWorkspaceAccess` returns (rule 5).
 */
function membershipContainer(memberRole: 'admin' | 'member' | 'viewer' | null): ServerContainer {
  return {
    workspaceService: {
      accessRowOf: async () => ({
        accountId: 'acc_1',
        ownerUserId: null,
        accessMode: 'restricted' as const,
      }),
      memberRoleOf: async () => memberRole,
    },
    accountService: { rolesFor: async () => ['developer'] },
    caches: {
      workspaceAccess: {
        get: async (_key: string, _group: string, load: () => Promise<unknown>) => load(),
      },
    },
  } as unknown as ServerContainer
}

describe('whose policy a bound key’s run is admitted under', () => {
  it('pins the tier the bound user holds on this board', async () => {
    // The whole point: without a role the run escapes `dryRunForcedForRole` and both role-scoped
    // merge narrowings, so a key would land what its own holder could not land from the board.
    expect(await keyInitiatorRole(membershipContainer('member'), 'ws_1', BOUND_USER)).toBe('member')
    expect(await keyInitiatorRole(membershipContainer('admin'), 'ws_1', BOUND_USER)).toBe('admin')
  })

  it('resolves no tier for an unbound key, without asking the roster', async () => {
    const container = {
      workspaceService: {
        accessRowOf: async () => {
          throw new Error('an unbound key has no membership to resolve')
        },
      },
    } as unknown as ServerContainer
    expect(await keyInitiatorRole(container, 'ws_1', null)).toBeNull()
  })

  it('resolves no tier for a bound user the board no longer admits', async () => {
    // A real state rather than a lowest tier (see `ExecutionInstance.initiatedByRole`): the key is
    // still authorized by its scope, and there is simply no tier left to narrow by.
    expect(await keyInitiatorRole(membershipContainer(null), 'ws_1', BOUND_USER)).toBeNull()
  })
})

interface ActivationFake {
  vendors: string[]
  fresh: boolean
  activated: string[]
  container: ServerContainer
}

/** A container answering the run's vendor set plus the personal-subscription store. */
function activationContainer(options: { vendors: string[]; fresh: boolean }): ActivationFake {
  const activated: string[] = []
  const personal = {
    list: async () => options.vendors.map((vendor) => ({ vendor })),
    hasFreshActivation: async () => options.fresh,
    activateForRun: async (_run: string, _user: string, vendor: string) => {
      activated.push(vendor)
    },
  } as unknown as PersonalSubscriptionService
  return {
    vendors: options.vendors,
    fresh: options.fresh,
    activated,
    container: {
      config: {},
      personalSubscriptions: personal,
      executionService: { individualVendorsForRun: async () => options.vendors },
    } as unknown as ServerContainer,
  }
}

describe('re-deriving the credential when a park is answered', () => {
  it('re-mints the activation while the password is in hand', async () => {
    const fake = activationContainer({ vendors: ['claude'], fresh: false })
    await refreshRunActivation(fake.container, 'ws_1', 'exec_1', { id: BOUND_USER }, 'hunter2')
    expect(fake.activated).toEqual(['claude'])
  })

  it('leaves a fresh activation alone, so a driver answering N parks does not re-derive N times', async () => {
    // The cost this avoids is not a round trip: each re-mint runs 210k PBKDF2 iterations per vendor,
    // which a human clicking once never notices and a loop answering eight follow-ups pays eight
    // times in a row — a CPU-limit kill on workerd rather than a slow request.
    const fake = activationContainer({ vendors: ['claude'], fresh: true })
    await refreshRunActivation(fake.container, 'ws_1', 'exec_1', { id: BOUND_USER }, 'hunter2')
    expect(fake.activated).toEqual([])
  })

  it('skips a fresh activation even with NO password, rather than refusing a run that is fine', async () => {
    // The gate exists to ask while the caller can still act on being asked. A run holding a
    // credential that outlives its next dispatch has nothing to ask about.
    const fake = activationContainer({ vendors: ['claude'], fresh: true })
    await expect(
      refreshRunActivation(fake.container, 'ws_1', 'exec_1', { id: BOUND_USER }, undefined),
    ).resolves.toBeUndefined()
  })

  it('demands the password when the activation would not survive the next dispatch', async () => {
    const fake = activationContainer({ vendors: ['claude'], fresh: false })
    await expect(
      refreshRunActivation(fake.container, 'ws_1', 'exec_1', { id: BOUND_USER }, undefined),
    ).rejects.toBeInstanceOf(CredentialRequiredError)
  })

  it('does nothing at all for a run that needs no personal credential', async () => {
    const fake = activationContainer({ vendors: [], fresh: false })
    await expect(
      refreshRunActivation(fake.container, 'ws_1', 'exec_1', undefined, undefined),
    ).resolves.toBeUndefined()
    expect(fake.activated).toEqual([])
  })
})

import type { PersonalSubscriptionService } from '@cat-factory/integrations'
import { userActivationScope } from '@cat-factory/kernel'
import { PERSONAL_PASSWORD_HEADER } from '@cat-factory/contracts'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { activateUserScope } from '../src/modules/providers/personalCredentialGate.js'

// The run-less half of the personal-credential flow: how a surface with no execution (the in-app
// assistant, the bug hunt) puts a supplied password to use.
//
// What is worth pinning here is what the helper does NOT do as much as what it does. It is not a
// gate: a surface whose model needs no personal credential must never be made to ask for a
// password, and a caller who has not supplied one is answered later, by the lease's own 428, at
// the point where the client knows to prompt. So the cases below are mostly about staying quiet.

function makeApp(over: {
  /** The vendors the asker holds a LIVE credential for (what `liveVendors` answers). */
  vendors?: string[]
  fresh?: boolean
  user?: string | null
  personalStore?: false
  ambient?: string[]
  /** Whether this deployment can serve a subscription ref inline, i.e. lease what is minted. */
  inlineHarness?: false
  /** Make every mint fail, to pin that a mint failure is not the request's refusal. */
  activateThrows?: Error
}) {
  const activate = vi.fn(async () => {
    if (over.activateThrows) throw over.activateThrows
  })
  const hasFresh = vi.fn(async () => over.fresh ?? false)
  const container = {
    config: {
      nativeAmbientAuth: over.ambient ?? [],
      agents: over.inlineHarness === false ? {} : { inlineHarnessRef: () => true },
    },
    ...(over.personalStore === false
      ? {}
      : {
          personalSubscriptions: {
            liveVendors: async () => new Set(over.vendors ?? []),
            hasFreshActivation: hasFresh,
            activate,
          } as unknown as PersonalSubscriptionService,
        }),
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    if (over.user !== null) c.set('user', { id: over.user ?? 'usr_1' } as never)
    await next()
  })
  app.post('/turn', async (c) => {
    await activateUserScope(c)
    return c.json({ ok: true })
  })
  return { app, activate, hasFresh }
}

const turn = (app: Hono<AppEnv>, headers: Record<string, string> = {}) =>
  app.request('/turn', { method: 'POST', headers })

describe('activateUserScope', () => {
  it('mints the USER scope for every individual vendor the asker holds', async () => {
    const { app, activate } = makeApp({ vendors: ['claude'] })

    expect((await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })).status).toBe(200)

    // Keyed on the PERSON, not a run: this surface has no execution, and a run-keyed activation
    // would be one nothing ever mints and nothing ever settles.
    expect(activate).toHaveBeenCalledWith(
      userActivationScope('usr_1'),
      'usr_1',
      'claude',
      'correct horse',
    )
  })

  it('does nothing at all without a password, rather than refusing the request', async () => {
    // The whole reason this is not a gate. A turn whose model needs no personal credential is the
    // common case, and prompting it for a password would be asking for something it cannot use.
    const { app, activate } = makeApp({ vendors: ['claude'] })

    expect((await turn(app)).status).toBe(200)
    expect(activate).not.toHaveBeenCalled()
  })

  it('skips a vendor whose activation is still fresh', async () => {
    // Each mint derives the password's key with 210k PBKDF2 iterations. An assistant turn is a
    // per-sentence surface, so paying that per request would be seconds of blocked event loop on
    // Node and a CPU-limit kill on workerd.
    const { app, activate, hasFresh } = makeApp({ vendors: ['claude'], fresh: true })

    await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })

    expect(hasFresh).toHaveBeenCalledWith(userActivationScope('usr_1'), 'usr_1', 'claude')
    expect(activate).not.toHaveBeenCalled()
  })

  it('skips a vendor this deployment serves from the host CLI ambient login', async () => {
    // Local mode with `claude` on PATH: there is no managed credential to activate, so minting
    // one would pay the derivation for a token nothing will open.
    const { app, activate } = makeApp({ vendors: ['claude'], ambient: ['claude-code'] })

    await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })

    expect(activate).not.toHaveBeenCalled()
  })

  it('stays quiet for an unauthenticated caller', async () => {
    const { app, activate } = makeApp({ vendors: ['claude'], user: null })

    expect((await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })).status).toBe(200)
    expect(activate).not.toHaveBeenCalled()
  })

  it('stays quiet on a deployment with no personal-credential store', async () => {
    // No ENCRYPTION_KEY. The turn still runs; it simply cannot reach a personal subscription.
    const { app } = makeApp({ personalStore: false })

    expect((await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })).status).toBe(200)
  })

  it('mints one scope per held vendor, all under the same person', async () => {
    const { app, activate } = makeApp({ vendors: ['claude', 'codex'] })

    await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })

    const scopes = activate.mock.calls.map((call) => (call as unknown[])[0])
    expect(scopes).toEqual([userActivationScope('usr_1'), userActivationScope('usr_1')])
  })

  it('stays quiet where nothing could lease what it would mint', async () => {
    // A user activation is opened by the inline subscription backend and by nothing else, and
    // that exists only where the deployment can keep a subscription ref inline. Elsewhere the
    // ref degrades to the routing default before any lease, so the 210k-iteration derivation
    // would be paid, per turn, for a row no reader has.
    const { app, activate } = makeApp({ vendors: ['claude'], inlineHarness: false })

    expect((await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })).status).toBe(200)
    expect(activate).not.toHaveBeenCalled()
  })

  it('never mints for a credential the asker cannot unlock, whatever they type', async () => {
    // `liveVendors` excludes an EXPIRED subscription, and that is the point: minting for one
    // raises `subscription_expired`, which from here would refuse every turn on this surface over
    // a credential the turn does not need, behind a modal no password can satisfy.
    const { app, activate } = makeApp({ vendors: [] })

    expect((await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })).status).toBe(200)
    expect(activate).not.toHaveBeenCalled()
  })

  it('answers the request even when the mint itself fails', async () => {
    // A password that opens nothing is a fact about a CREDENTIAL, not about this turn. The lease
    // is the one refusal, and it fires only where the credential is actually needed; refusing
    // here would refuse turns that never wanted it.
    const { app } = makeApp({
      vendors: ['claude'],
      activateThrows: new Error('the personal password does not unlock claude'),
    })

    expect((await turn(app, { [PERSONAL_PASSWORD_HEADER]: 'wrong horse' })).status).toBe(200)
  })
})

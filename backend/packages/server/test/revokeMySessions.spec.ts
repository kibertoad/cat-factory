import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { authController } from '../src/modules/auth/AuthController.js'
import { mountAuthGate } from '../src/http/authGate.js'
import { handleError } from '../src/http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { HmacSigner, TOKEN_AUDIENCE, type SessionPayload } from '../src/auth/signing.js'

// The self-serve "sign out everywhere" endpoint, driven through the app AS ASSEMBLED — the gate
// mounted, the controller routed under `/auth`, a real signed bearer on the request.
//
// The assembly is the whole point rather than ceremony. `/auth` is a PUBLIC prefix (the login
// round-trips have to be reachable unauthenticated), so `requireAuth` never runs for these routes
// and nothing ever populates `c.get('user')`. A route here that reaches for `requireUser` is not
// a guard that might be too strict: it is an unconditional 401 for every caller, valid session
// included. Nothing about the source says so, and the only thing that can see it is a test that
// signs a real token and expects a real 200.

const SECRET = 's'.repeat(32)

function harness(opts: { generation?: number; revokeThrows?: boolean } = {}) {
  const revoked: string[] = []
  const container = {
    config: {
      auth: {
        enabled: true,
        devOpen: false,
        githubEnabled: false,
        passwordEnabled: false,
        sessionSecret: SECRET,
        sessionTtlMs: 3_600_000,
        allowedLogins: [],
        allowedOrgs: [],
        allowedRedirectOrigins: [],
        allowedEmailDomains: [],
      },
    },
    userService: {
      sessionGeneration: async () => opts.generation ?? 0,
      refreshSessionGeneration: async () => opts.generation ?? 0,
      revokeSessions: async (userId: string) => {
        if (opts.revokeThrows) throw new Error('store down')
        revoked.push(userId)
        return (opts.generation ?? 0) + 1
      },
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  mountAuthGate(app)
  app.route('/auth', authController())

  return {
    revoked,
    call: (token?: string) =>
      app.fetch(
        new Request('https://t.test/auth/sessions/revoke-all', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        }),
      ),
  }
}

function sessionToken(overrides: Partial<SessionPayload> = {}): Promise<string> {
  const payload: SessionPayload = {
    id: 'usr_1',
    login: 'ada',
    name: 'Ada Lovelace',
    avatarUrl: 'https://avatars.test/ada.png',
    email: 'ada@acme.com',
    aud: TOKEN_AUDIENCE.session,
    exp: Date.now() + 3_600_000,
    gen: 0,
    ...overrides,
  }
  return new HmacSigner(SECRET).sign(payload)
}

/** Read a minted token's claims back without re-verifying (the assertions are about content). */
async function claimsOf(token: string): Promise<SessionPayload | null> {
  return new HmacSigner(SECRET).verify<SessionPayload>(token, { aud: TOKEN_AUDIENCE.session })
}

describe('POST /auth/sessions/revoke-all', () => {
  it('revokes and re-mints for a caller holding a valid session', async () => {
    const h = harness()
    const res = await h.call(await sessionToken())

    expect(res.status).toBe(200)
    expect(h.revoked).toEqual(['usr_1'])
  })

  it('re-mints from the NEW generation, so the returned token outlives the revocation', async () => {
    // The endpoint deliberately invalidates the very token that called it — somebody reaching for
    // "sign out everywhere" has usually lost a device and cannot say which session to keep. The
    // replacement is what stops that from signing the asking browser out too, and it is only a
    // replacement if it carries the generation the bump produced rather than the one it replaced.
    const h = harness({ generation: 4 })
    const res = await h.call(await sessionToken({ gen: 4 }))
    const body = (await res.json()) as { token: string }

    expect((await claimsOf(body.token))?.gen).toBe(5)
  })

  it('carries the caller’s EMAIL onto the replacement token', async () => {
    // `email` is optional on `SessionUser`, so a hand-picked projection that omits it typechecks
    // and silently downgrades the session: `/auth/me` starts reporting a null address and
    // invitation acceptance stops matching the person by it. Re-minting must be lossless.
    const h = harness()
    const res = await h.call(await sessionToken())
    const body = (await res.json()) as { token: string }
    const claims = await claimsOf(body.token)

    expect(claims).toMatchObject({
      id: 'usr_1',
      login: 'ada',
      name: 'Ada Lovelace',
      avatarUrl: 'https://avatars.test/ada.png',
      email: 'ada@acme.com',
    })
  })

  it('refuses an unauthenticated caller without touching the store', async () => {
    const h = harness()
    const res = await h.call()

    expect(res.status).toBe(401)
    expect(h.revoked).toEqual([])
  })

  it('refuses a token whose generation the store has already moved past', async () => {
    // The route is public-prefixed, so its own `verifySession` is the only thing standing between
    // an already-revoked bearer and another revocation. It has to run the same check the gate
    // would have.
    const h = harness({ generation: 7 })
    const res = await h.call(await sessionToken({ gen: 6 }))

    expect(res.status).toBe(401)
    expect(h.revoked).toEqual([])
  })
})

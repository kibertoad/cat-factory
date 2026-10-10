import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { PROVIDER_CALLBACK_CONTROLLERS } from '../app.js'
import { mountAuthGate, PUBLIC_PREFIXES } from './authGate.js'
import { handleError } from './errorHandler.js'
import type { AppEnv } from './env.js'

// ---------------------------------------------------------------------------
// The public-receiver invariant: EVERY PROVIDER-FACING RECEIVER THE APP MOUNTS IS REACHABLE
// WITHOUT A SESSION.
//
// These receivers authenticate themselves — an HMAC signature over the raw body, or a signed,
// short-lived `state` on an OAuth redirect. Their callers cannot do anything else: a vendor's
// browser redirect carries no `Authorization` header and a webhook delivery has no session to
// carry. So a receiver whose mount is missing from `PUBLIC_PREFIXES` is not "gated" in any useful
// sense; it is UNREACHABLE, and it fails as a 401 (or a 503 where auth is unconfigured) raised
// before the handler whose own signature check is the real authentication ever runs.
//
// That failure is invisible from every side that looks correct. The receiver reads correctly at
// its own mount, its handler's verification is right, and the only surface that disagrees is a
// third-party redirect nobody can retry. Both times it has been got wrong (the Linear callback at
// `/tasks`, then the document-source callback at `/documents`), the mount line and the allowlist
// were edited in different files at different times.
//
// The two tests are complements and neither subsumes the other. The first compares the two lists,
// which catches the omission at its source and names the receiver. The second drives the REAL gate
// against a deployment with auth unconfigured — the state in which the gate fails closed — so it
// judges what a request actually does rather than restating the allowlist: a prefix that is listed
// but does not match the way the gate compares (a trailing slash, a regex-shaped entry) passes the
// first test and fails this one.
// ---------------------------------------------------------------------------

/** A container stub with auth UNCONFIGURED, which is when the gate fails closed with a 503. */
function unauthenticatedContainer(): unknown {
  return { config: { auth: { sessionSecret: '', enabled: false, devOpen: false } } }
}

/** The real gate, in front of one catch-all that reports having been reached. */
function appWithGate(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', unauthenticatedContainer() as never)
    await next()
  })
  mountAuthGate(app)
  app.all('*', (c) => c.json({ reached: true }, 200))
  return app
}

describe('public receiver prefixes', () => {
  it('lists every provider-facing receiver mount in PUBLIC_PREFIXES', () => {
    const missing = PROVIDER_CALLBACK_CONTROLLERS.filter(
      (entry) => !PUBLIC_PREFIXES.includes(entry.mount),
    ).map((entry) => `${entry.name} (${entry.mount})`)
    expect(missing).toEqual([])
  })

  it('passes a request to each receiver mount through the gate untouched', async () => {
    const app = appWithGate()
    for (const entry of PROVIDER_CALLBACK_CONTROLLERS) {
      const res = await app.request(`${entry.mount}/oauth/callback`)
      expect(res.status, `${entry.name} at ${entry.mount} is behind the session gate`).toBe(200)
    }
  })

  it('still fails closed for a route that is not a public receiver', async () => {
    // The complement, so the test above cannot pass by the gate having been disabled outright.
    const res = await appWithGate().request('/workspaces/w1/blocks')
    expect(res.status).toBe(503)
  })
})

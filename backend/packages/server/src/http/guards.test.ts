import { Hono } from 'hono'
import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import { handleError } from './errorHandler.js'
import { assertCapability, assertUser, requireCapability, requireUser } from './guards.js'
import type { AppEnv } from './env.js'

// These are the two guards every controller now routes its refusals through, so what they refuse
// — and the envelope the refusal lands in — is asserted here rather than inferred from ~300 call
// sites. They THROW rather than build an envelope so the single `handleError` funnel owns the
// wire shape and the refusal can carry `details.reason` (observability-logging-gaps.md, B2).

function appWith(handler: (c: Context<AppEnv>) => Response) {
  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.get('/thing', handler)
  return app
}

describe('requireCapability', () => {
  it('returns the value when the capability is wired', () => {
    const module = { service: 'here' }
    expect(requireCapability(module, 'nope')).toBe(module)
  })

  it('refuses undefined and null with a 503 naming what is missing', async () => {
    for (const absent of [undefined, null]) {
      const res = await appWith(() =>
        Response.json(requireCapability(absent, 'Kaizen is not configured')),
      ).request('/thing')
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({
        error: { code: 'unavailable', message: 'Kaizen is not configured' },
      })
    }
  })

  // The check is `=== undefined || === null`, NOT falsiness. A capability is a module or a
  // repository handle, but the narrower check is what lets a caller guard a legitimately falsy
  // value without it reading as unwired — and `AuthController` keeps a direct throw precisely
  // because what IT guards is a boolean FLAG, where there is no value to narrow.
  it('passes falsy-but-present values through rather than treating them as unwired', () => {
    expect(requireCapability(false, 'nope')).toBe(false)
    expect(requireCapability(0, 'nope')).toBe(0)
    expect(requireCapability('', 'nope')).toBe('')
  })
})

describe('requireUser', () => {
  it('refuses an anonymous caller with a 401 wording the action', async () => {
    const res = await appWith((c) =>
      Response.json(requireUser(c, 'Sign in to manage your API keys')),
    ).request('/thing')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { code: 'unauthorized', message: 'Sign in to manage your API keys' },
    })
  })

  it('returns the session user when one is signed in', async () => {
    const app = new Hono<AppEnv>()
    app.onError(handleError)
    const user = { id: 'u_1', login: 'ada', name: 'Ada' }
    app.use('*', async (c, next) => {
      c.set('user', user as never)
      await next()
    })
    app.get('/thing', (c) => c.json(requireUser(c, 'Sign in')))
    const res = await app.request('/thing')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'u_1' })
  })
})

// The `assert*` twins exist so a route that needs a guard but reads nothing off it doesn't read
// as a no-op statement. They must refuse exactly as their `require*` originals do — an assert
// that merely looked like a guard would be worse than the discarded call it replaced.
describe('the assert twins refuse identically', () => {
  it('assertCapability 503s on an unwired capability and returns void otherwise', async () => {
    const res = await appWith(() => {
      assertCapability(undefined, 'Clarity review is not configured')
      return Response.json({ reached: true })
    }).request('/thing')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      error: { code: 'unavailable', message: 'Clarity review is not configured' },
    })
    expect(assertCapability({ wired: true }, 'nope')).toBeUndefined()
  })

  it('assertUser 401s on an anonymous caller', async () => {
    const res = await appWith((c) => {
      assertUser(c, 'Sign in to manage your secrets')
      return Response.json({ reached: true })
    }).request('/thing')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { code: 'unauthorized', message: 'Sign in to manage your secrets' },
    })
  })
})

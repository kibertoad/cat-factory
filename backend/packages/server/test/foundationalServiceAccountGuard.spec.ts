import { NotFoundError } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { foundationalServiceController } from '../src/modules/foundationalServices/FoundationalServiceController.js'

// The account tier of the foundational-services API is authorized by ONE middleware mounted per
// top-level resource (`ACCOUNT_GUARDED_RESOURCES`), not by a `use('*')` — this controller shares
// the `/accounts/:accountId` mount with its siblings, so a wildcard would reach into their routes.
//
// The failure that makes this spec worth having: the guard was hand-enumerated as four literal
// `use` lines, and `GET /accounts/:id/foundational-service-suppressions` matched none of them. It
// was reachable by any SIGNED-IN user for ANY account id, returning that account's opted-out
// service ids (and the names/summaries of services it had deleted). Nothing failed — the route
// worked, for everybody.
//
// So the assertion here is deliberately NOT a list of paths anyone has to maintain: it enumerates
// every route the controller actually REGISTERED and requires each one to refuse a non-member.
// A new account-scope resource whose guard line is missing fails this, whatever it is called.

/** Every route the account-scope controller registers, with its params filled in. */
function registeredAccountRoutes(): { method: string; path: string }[] {
  return foundationalServiceController('account')
    .routes // `use()` registers as ALL; only the contract-bound handlers are routes a caller can reach.
    .filter((route) => route.method !== 'ALL')
    .map((route) => ({
      method: route.method,
      path: route.path.replace(/:[A-Za-z]+/g, 'x'),
    }))
}

/**
 * Mount the account controller behind a container whose catalog and source services RECORD every
 * call, so an unguarded route is visible as a reached service and not only as a status code.
 */
function mount(opts: { member: boolean; anonymous?: boolean }) {
  const reached: string[] = []
  /** Any method, recorded — so the fake does not have to track the service's real surface. */
  const recording = (label: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, property) =>
          async (..._args: unknown[]) => {
            reached.push(`${label}.${String(property)}`)
            return []
          },
      },
    )

  const requireMember = vi.fn(async () => {
    // What the real `AccountService.requireMember` throws for a non-member: a 404, so existence is
    // hidden exactly as the workspace gate hides a foreign board.
    if (!opts.member) throw new NotFoundError('Account', 'acct_other')
  })

  const container = {
    foundationalServices: {
      catalogService: recording('catalog'),
      sourceService: recording('sources'),
    },
    accountService: { requireMember },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    if (!opts.anonymous) c.set('user', { id: 'usr_1' } as never)
    await next()
  })
  app.route('/accounts/:accountId', foundationalServiceController('account'))

  const call = (method: string, path: string) =>
    app.fetch(new Request(`https://t.test/accounts/acct_other${path}`, { method }))
  return { call, reached, requireMember }
}

describe('foundational services — account-scope authorization', () => {
  it('enumerates the routes it is asserting over, so it cannot pass vacuously', () => {
    const routes = registeredAccountRoutes()
    // Services (4) + suppressions (3) + sources (5). A shrink means the enumeration broke, not
    // that the surface did — and a silently empty list would make every assertion below trivial.
    expect(routes.length).toBeGreaterThanOrEqual(12)
    expect(routes.map((r) => r.path)).toContain('/foundational-service-suppressions')
  })

  it('refuses EVERY registered route for a non-member, before the service is touched', async () => {
    const { call, reached } = mount({ member: false })
    for (const route of registeredAccountRoutes()) {
      const res = await call(route.method, route.path)
      // 404, never 400/401/200: the guard runs ahead of contract validation, so a route that
      // answered anything else was reached without being authorized. That is the whole assertion —
      // an unguarded GET would 200 here, and an unguarded POST would 400 on its missing body.
      expect(`${route.method} ${route.path} -> ${res.status}`).toBe(
        `${route.method} ${route.path} -> 404`,
      )
    }
    expect(reached).toEqual([])
  })

  it('refuses every registered route for an anonymous caller', async () => {
    const { call, reached } = mount({ member: true, anonymous: true })
    for (const route of registeredAccountRoutes()) {
      const res = await call(route.method, route.path)
      expect(`${route.method} ${route.path} -> ${res.status}`).toBe(
        `${route.method} ${route.path} -> 401`,
      )
    }
    expect(reached).toEqual([])
  })

  it('lets a MEMBER through to the service, so the refusals above are not a routing artefact', async () => {
    const { call, reached, requireMember } = mount({ member: true })
    const res = await call('GET', '/foundational-service-suppressions')
    expect(res.status).toBe(200)
    expect(requireMember).toHaveBeenCalledWith('acct_other', 'usr_1')
    expect(reached).toEqual(['catalog.listSuppressions'])
  })
})

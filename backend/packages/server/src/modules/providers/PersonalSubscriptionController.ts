import {
  listPersonalSubscriptionsContract,
  removePersonalSubscriptionContract,
  storePersonalSubscriptionContract,
  subscriptionVendorSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

// Per-USER individual-usage subscription endpoints (Claude). Unlike the workspace
// vendor-credential pool, these are scoped to the signed-in user: a personal
// subscription is licensed for that individual only, stored DOUBLE-encrypted (a
// personal-password layer inside the system layer), and never shared. Mounted at the
// root (not under a workspace) and require a signed-in user — with auth disabled there
// is no individual to own a personal credential.

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unauthorized', message: 'Sign in to manage personal subscriptions' } },
    401,
  )

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Personal subscription storage is not configured' } },
    503,
  )

export function personalSubscriptionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPersonalSubscriptionsContract, async (c) => {
    const personal = c.get('container').personalSubscriptions
    if (!personal) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json({ subscriptions: await personal.list(user.id) }, 200)
  })

  buildHonoRoute(app, storePersonalSubscriptionContract, async (c) => {
    const personal = c.get('container').personalSubscriptions
    if (!personal) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const status = await personal.store(user.id, c.req.valid('json'))
    return c.json(status, 201)
  })

  buildHonoRoute(app, removePersonalSubscriptionContract, async (c) => {
    const personal = c.get('container').personalSubscriptions
    if (!personal) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const vendor = v.parse(subscriptionVendorSchema, c.req.valid('param').vendor)
    await personal.remove(user.id, vendor)
    return c.body(null, 204)
  })

  return app
}

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
import { requireCapability, requireUser } from '../../http/guards.js'

// Per-USER individual-usage subscription endpoints (Claude). Unlike the workspace
// vendor-credential pool, these are scoped to the signed-in user: a personal
// subscription is licensed for that individual only, stored DOUBLE-encrypted (a
// personal-password layer inside the system layer), and never shared. Mounted at the
// root (not under a workspace) and require a signed-in user — with auth disabled there
// is no individual to own a personal credential.

/** Resolve the personal-subscription store, or refuse with a 503 naming what isn't wired. */
function requirePersonalSubscriptions<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    c.get('container').personalSubscriptions,
    'Personal subscription storage is not configured',
  )
}

/** The signed-in caller, or a 401 wording the prompt for what this controller manages. */
function requireSignedIn<E extends AppEnv>(c: Context<E>) {
  return requireUser(c, 'Sign in to manage personal subscriptions')
}

export function personalSubscriptionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPersonalSubscriptionsContract, async (c) => {
    const personal = requirePersonalSubscriptions(c)
    const user = requireSignedIn(c)
    return c.json({ subscriptions: await personal.list(user.id) }, 200)
  })

  buildHonoRoute(app, storePersonalSubscriptionContract, async (c) => {
    const personal = requirePersonalSubscriptions(c)
    const user = requireSignedIn(c)
    const status = await personal.store(user.id, c.req.valid('json'))
    return c.json(status, 201)
  })

  buildHonoRoute(app, removePersonalSubscriptionContract, async (c) => {
    const personal = requirePersonalSubscriptions(c)
    const user = requireSignedIn(c)
    const vendor = v.parse(subscriptionVendorSchema, c.req.valid('param').vendor)
    await personal.remove(user.id, vendor)
    return c.body(null, 204)
  })

  return app
}

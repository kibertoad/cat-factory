import {
  listPersonalSubscriptionsContract,
  removePersonalSubscriptionContract,
  storePersonalSubscriptionContract,
  subscriptionVendorSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { UnavailableError, UnauthorizedError } from '@cat-factory/kernel'

// Per-USER individual-usage subscription endpoints (Claude). Unlike the workspace
// vendor-credential pool, these are scoped to the signed-in user: a personal
// subscription is licensed for that individual only, stored DOUBLE-encrypted (a
// personal-password layer inside the system layer), and never shared. Mounted at the
// root (not under a workspace) and require a signed-in user — with auth disabled there
// is no individual to own a personal credential.

const signInRequired = (): never => {
  throw new UnauthorizedError('Sign in to manage personal subscriptions')
}

const unavailable = (): never => {
  throw new UnavailableError('Personal subscription storage is not configured')
}

export function personalSubscriptionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPersonalSubscriptionsContract, async (c) => {
    const personal = c.get('container').personalSubscriptions
    if (!personal) return unavailable()
    const user = c.get('user')
    if (!user) return signInRequired()
    return c.json({ subscriptions: await personal.list(user.id) }, 200)
  })

  buildHonoRoute(app, storePersonalSubscriptionContract, async (c) => {
    const personal = c.get('container').personalSubscriptions
    if (!personal) return unavailable()
    const user = c.get('user')
    if (!user) return signInRequired()
    const status = await personal.store(user.id, c.req.valid('json'))
    return c.json(status, 201)
  })

  buildHonoRoute(app, removePersonalSubscriptionContract, async (c) => {
    const personal = c.get('container').personalSubscriptions
    if (!personal) return unavailable()
    const user = c.get('user')
    if (!user) return signInRequired()
    const vendor = v.parse(subscriptionVendorSchema, c.req.valid('param').vendor)
    await personal.remove(user.id, vendor)
    return c.body(null, 204)
  })

  return app
}

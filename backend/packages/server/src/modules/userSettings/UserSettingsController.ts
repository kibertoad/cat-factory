import { getUserSettingsContract, updateUserSettingsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability, requireUser } from '../../http/guards.js'

// Per-USER settings (today: the user-tier spend budget). Scoped to the signed-in user
// (not a workspace), mounted at the root, like personal subscriptions + local model
// runners. Absent user-settings persistence ⇒ 503 (unconfigured facade / tests).

/** The `userSettings` capability, or a 503 — this deployment wired none. */
const requireUserSettings = <E extends AppEnv>(c: Context<E>) =>
  requireCapability(c.get('container').userSettings, 'User settings storage is not configured')

/** The signed-in user, or a 401 naming the action. */
const requireSignedIn = <E extends AppEnv>(c: Context<E>) =>
  requireUser(c, 'Sign in to manage your settings')

export function userSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getUserSettingsContract, async (c) => {
    const settings = requireUserSettings(c)
    const user = requireSignedIn(c)
    return c.json(await settings.service.get(user.id), 200)
  })

  buildHonoRoute(app, updateUserSettingsContract, async (c) => {
    const settings = requireUserSettings(c)
    const user = requireSignedIn(c)
    return c.json(await settings.service.update(user.id, c.req.valid('json')), 200)
  })

  return app
}

import { getUserSettingsContract, updateUserSettingsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability, requireUser } from '../../http/guards.js'

// Per-USER settings (today: the user-tier spend budget). Scoped to the signed-in user
// (not a workspace), mounted at the root, like personal subscriptions + local model
// runners. Absent user-settings persistence ⇒ 503 (unconfigured facade / tests).

export function userSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getUserSettingsContract, async (c) => {
    const settings = requireCapability(
      c.get('container').userSettings,
      'User settings storage is not configured',
    )
    const user = requireUser(c, 'Sign in to manage your settings')
    return c.json(await settings.service.get(user.id), 200)
  })

  buildHonoRoute(app, updateUserSettingsContract, async (c) => {
    const settings = requireCapability(
      c.get('container').userSettings,
      'User settings storage is not configured',
    )
    const user = requireUser(c, 'Sign in to manage your settings')
    return c.json(await settings.service.update(user.id, c.req.valid('json')), 200)
  })

  return app
}

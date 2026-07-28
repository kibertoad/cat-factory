import { getUserSettingsContract, updateUserSettingsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { UnavailableError, UnauthorizedError } from '@cat-factory/kernel'

// Per-USER settings (today: the user-tier spend budget). Scoped to the signed-in user
// (not a workspace), mounted at the root, like personal subscriptions + local model
// runners. Absent user-settings persistence ⇒ 503 (unconfigured facade / tests).

const signInRequired = (): never => {
  throw new UnauthorizedError('Sign in to manage your settings')
}

const unavailable = (): never => {
  throw new UnavailableError('User settings storage is not configured')
}

export function userSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getUserSettingsContract, async (c) => {
    const settings = c.get('container').userSettings
    if (!settings) return unavailable()
    const user = c.get('user')
    if (!user) return signInRequired()
    return c.json(await settings.service.get(user.id), 200)
  })

  buildHonoRoute(app, updateUserSettingsContract, async (c) => {
    const settings = c.get('container').userSettings
    if (!settings) return unavailable()
    const user = c.get('user')
    if (!user) return signInRequired()
    return c.json(await settings.service.update(user.id, c.req.valid('json')), 200)
  })

  return app
}

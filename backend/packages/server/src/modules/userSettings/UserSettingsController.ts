import { getUserSettingsContract, updateUserSettingsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

// Per-USER settings (today: the user-tier spend budget). Scoped to the signed-in user
// (not a workspace), mounted at the root, like personal subscriptions + local model
// runners. Absent user-settings persistence ⇒ 503 (unconfigured facade / tests).

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unauthorized', message: 'Sign in to manage your settings' } }, 401)

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'User settings storage is not configured' } },
    503,
  )

export function userSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getUserSettingsContract, async (c) => {
    const settings = c.get('container').userSettings
    if (!settings) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json(await settings.service.get(user.id), 200)
  })

  buildHonoRoute(app, updateUserSettingsContract, async (c) => {
    const settings = c.get('container').userSettings
    if (!settings) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json(await settings.service.update(user.id, c.req.valid('json')), 200)
  })

  return app
}

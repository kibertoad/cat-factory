import { getLocalSettingsContract, updateLocalSettingsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

/**
 * Local-mode operational settings (warm-container-pool sizing + per-repo checkout reuse),
 * a per-deployment singleton that replaced the old `LOCAL_POOL_*` / `HARNESS_*` env vars.
 * Mounted on every facade but wired only on the local-mode facade — it 503s elsewhere (the
 * warm pool is the local Docker-family runner's differentiator, with no Cloudflare/Node
 * equivalent). There are no secrets, so `GET` returns the plain config and `PUT` replaces
 * it wholesale. Not auth-gated beyond the facade's gate: local mode runs with the auth gate
 * open on the developer's own machine, and the settings store is wired only there.
 */
export function localSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const unavailable = <E extends AppEnv>(c: Context<E>) =>
    c.json(
      {
        error: {
          code: 'unavailable',
          message: 'Local-mode settings are only available on the local-mode service',
        },
      },
      503,
    )

  buildHonoRoute(app, getLocalSettingsContract, async (c) => {
    const container = c.get('container')
    if (!container.localSettings) return unavailable(c)
    return c.json(await container.localSettings.service.read(), 200)
  })

  buildHonoRoute(app, updateLocalSettingsContract, async (c) => {
    const container = c.get('container')
    if (!container.localSettings) return unavailable(c)
    return c.json(await container.localSettings.service.write(c.req.valid('json')), 200)
  })

  return app
}

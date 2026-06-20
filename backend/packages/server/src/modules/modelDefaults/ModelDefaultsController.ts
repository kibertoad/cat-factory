import { setModelDefaultsSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ModelDefaultsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the model-defaults module or send a 503, returning null when unconfigured. */
function requireModelDefaults(c: Context<AppEnv>): ModelDefaultsModule | null {
  return c.get('container').modelDefaults ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Model defaults are not configured' } }, 503)

/**
 * Read/replace a workspace's per-agent-kind default models (the model each agent
 * kind defaults to, overriding the env routing for that workspace). PUT replaces
 * the whole map wholesale. Mounted under `/workspaces/:workspaceId`.
 */
export function modelDefaultsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/model-defaults', async (c) => {
    const defaults = requireModelDefaults(c)
    if (!defaults) return unavailable(c)
    return c.json(await defaults.service.get(param(c, 'workspaceId')))
  })

  app.put('/model-defaults', jsonBody(setModelDefaultsSchema), async (c) => {
    const defaults = requireModelDefaults(c)
    if (!defaults) return unavailable(c)
    const stored = await defaults.service.set(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(stored)
  })

  return app
}

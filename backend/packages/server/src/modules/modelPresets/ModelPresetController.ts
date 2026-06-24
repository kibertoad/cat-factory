import { createModelPresetSchema, updateModelPresetSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ModelPresetsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the model-preset module or send a 503, returning null when unconfigured. */
function requireModelPresets(c: Context<AppEnv>): ModelPresetsModule | null {
  return c.get('container').modelPresets ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Model presets are not configured' } }, 503)

/**
 * CRUD for a workspace's model presets (the library a task picks its model→agent
 * mapping from; each preset is a base model applied to every agent kind plus per-kind
 * overrides). The built-in presets are seeded lazily on first list and the default
 * cannot be deleted/unset. Mounted under `/workspaces/:workspaceId`.
 */
export function modelPresetController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/model-presets', async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    return c.json(await presets.service.list(param(c, 'workspaceId')))
  })

  app.post('/model-presets', jsonBody(createModelPresetSchema), async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(preset, 201)
  })

  app.patch('/model-presets/:presetId', jsonBody(updateModelPresetSchema), async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.update(
      param(c, 'workspaceId'),
      param(c, 'presetId'),
      c.req.valid('json'),
    )
    return c.json(preset)
  })

  app.delete('/model-presets/:presetId', async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    await presets.service.remove(param(c, 'workspaceId'), param(c, 'presetId'))
    return c.body(null, 204)
  })

  return app
}

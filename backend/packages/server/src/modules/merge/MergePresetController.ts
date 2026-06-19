import { createMergePresetSchema, updateMergePresetSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { MergePresetsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the merge-preset module or send a 503, returning null when unconfigured. */
function requireMergePresets(c: Context<AppEnv>): MergePresetsModule | null {
  return c.get('container').mergePresets ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Merge presets are not configured' } }, 503)

/**
 * CRUD for a workspace's merge threshold presets (the library a task picks its
 * auto-merge policy from). The default preset is seeded lazily on first list and
 * cannot be deleted/unset. Mounted under `/workspaces/:workspaceId`.
 */
export function mergePresetController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/merge-presets', async (c) => {
    const presets = requireMergePresets(c)
    if (!presets) return unavailable(c)
    return c.json(await presets.service.list(param(c, 'workspaceId')))
  })

  app.post('/merge-presets', jsonBody(createMergePresetSchema), async (c) => {
    const presets = requireMergePresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(preset, 201)
  })

  app.patch('/merge-presets/:presetId', jsonBody(updateMergePresetSchema), async (c) => {
    const presets = requireMergePresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.update(
      param(c, 'workspaceId'),
      param(c, 'presetId'),
      c.req.valid('json'),
    )
    return c.json(preset)
  })

  app.delete('/merge-presets/:presetId', async (c) => {
    const presets = requireMergePresets(c)
    if (!presets) return unavailable(c)
    await presets.service.remove(param(c, 'workspaceId'), param(c, 'presetId'))
    return c.body(null, 204)
  })

  return app
}

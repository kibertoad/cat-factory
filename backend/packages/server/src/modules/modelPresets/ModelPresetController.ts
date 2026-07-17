import {
  createModelPresetContract,
  deleteModelPresetContract,
  listModelPresetsContract,
  reseedModelPresetContract,
  updateModelPresetContract,
} from '@cat-factory/contracts'
import type { ModelPresetsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'

/** Resolve the model-preset module or send a 503, returning null when unconfigured. */
function requireModelPresets<E extends AppEnv>(c: Context<E>): ModelPresetsModule | null {
  return c.get('container').modelPresets ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Model presets are not configured' } }, 503)

/**
 * CRUD for a workspace's model presets (the library a task picks its model→agent
 * mapping from; each preset is a base model applied to every agent kind plus per-kind
 * overrides). The built-in presets are seeded lazily on first list and the default
 * cannot be deleted/unset. Mounted under `/workspaces/:workspaceId`.
 */
export function modelPresetController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('settings.manage'))

  buildHonoRoute(app, listModelPresetsContract, async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    return c.json(await presets.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createModelPresetContract, async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(preset, 201)
  })

  buildHonoRoute(app, updateModelPresetContract, async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.update(
      param(c, 'workspaceId'),
      c.req.valid('param').presetId,
      c.req.valid('json'),
    )
    return c.json(preset, 200)
  })

  buildHonoRoute(app, deleteModelPresetContract, async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    await presets.service.remove(param(c, 'workspaceId'), c.req.valid('param').presetId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, reseedModelPresetContract, async (c) => {
    const presets = requireModelPresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.reseed(
      param(c, 'workspaceId'),
      c.req.valid('param').presetId,
    )
    return c.json(preset, 200)
  })

  return app
}

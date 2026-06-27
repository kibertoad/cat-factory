import {
  createMergePresetContract,
  deleteMergePresetContract,
  listMergePresetsContract,
  updateMergePresetContract,
} from '@cat-factory/contracts'
import type { MergePresetsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the merge-preset module or send a 503, returning null when unconfigured. */
function requireMergePresets<E extends AppEnv>(c: Context<E>): MergePresetsModule | null {
  return c.get('container').mergePresets ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Merge presets are not configured' } }, 503)

/**
 * CRUD for a workspace's merge threshold presets (the library a task picks its
 * auto-merge policy from). The default preset is seeded lazily on first list and
 * cannot be deleted/unset. Mounted under `/workspaces/:workspaceId`.
 */
export function mergePresetController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listMergePresetsContract, async (c) => {
    const presets = requireMergePresets(c)
    if (!presets) return unavailable(c)
    return c.json(await presets.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createMergePresetContract, async (c) => {
    const presets = requireMergePresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(preset, 201)
  })

  buildHonoRoute(app, updateMergePresetContract, async (c) => {
    const presets = requireMergePresets(c)
    if (!presets) return unavailable(c)
    const preset = await presets.service.update(
      param(c, 'workspaceId'),
      c.req.valid('param').presetId,
      c.req.valid('json'),
    )
    return c.json(preset, 200)
  })

  buildHonoRoute(app, deleteMergePresetContract, async (c) => {
    const presets = requireMergePresets(c)
    if (!presets) return unavailable(c)
    await presets.service.remove(param(c, 'workspaceId'), c.req.valid('param').presetId)
    return c.body(null, 204)
  })

  return app
}

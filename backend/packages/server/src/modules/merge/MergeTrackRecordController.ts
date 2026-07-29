import { listMergeClassRollupsContract, tagMergeReviewEffortContract } from '@cat-factory/contracts'
import type { MergeTrackRecordModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { UnavailableError } from '@cat-factory/kernel'

/** Resolve the merge track-record module or send a 503, returning null when unconfigured. */
function requireTrackRecords<E extends AppEnv>(c: Context<E>): MergeTrackRecordModule | null {
  return c.get('container').mergeTrackRecords ?? null
}

const unavailable = (): never => {
  throw new UnavailableError('Merge track records are not configured')
}

/**
 * The merge track record's read + tag surface: the per-change-class rollups the preset editor
 * renders each class's rule against, and the reviewer-effort tag a human leaves on a merged PR.
 *
 * Deliberately NOT gated behind `settings.manage`: reading a class's history and tagging how much
 * review a PR needed are member-tier actions (the same tier that merges through the notification
 * inbox), so the shared viewer write floor in `mountAuthGate` is the correct and only gate here —
 * a viewer cannot POST, a member can. Mounted under `/workspaces/:workspaceId`.
 */
export function mergeTrackRecordController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Every class in ONE request (a single SQL aggregate behind the port), so the preset editor
  // never fans out per class.
  buildHonoRoute(app, listMergeClassRollupsContract, async (c) => {
    const records = requireTrackRecords(c)
    if (!records) return unavailable()
    return c.json(await records.service.rollups(param(c, 'workspaceId')), 200)
  })

  // Tag (or clear) the reviewer effort a merged PR actually needed. The standalone route exists
  // because a tag can arrive with no notification act in flight — an external merge's
  // `merge_tag_request` nudge, or the inspector's merge controls.
  buildHonoRoute(app, tagMergeReviewEffortContract, async (c) => {
    const records = requireTrackRecords(c)
    if (!records) return unavailable()
    const updated = await records.service.tag(
      param(c, 'workspaceId'),
      c.req.valid('param').recordId,
      c.req.valid('json').reviewEffort,
    )
    return c.json(updated, 200)
  })

  return app
}

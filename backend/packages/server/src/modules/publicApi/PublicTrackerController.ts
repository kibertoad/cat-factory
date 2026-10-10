import {
  getPublicTrackerWritebackContract,
  updatePublicTrackerWritebackContract,
  type PublicTrackerWritebackSettings,
  type TrackerSettings,
  type TrackerWritebackFlags,
  type UpdatePublicTrackerWritebackInput,
} from '@cat-factory/contracts'
import type { TrackerModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { authorizeOrThrow } from './publicApiAuth.js'

// The workspace's tracker WRITEBACK disposition on `/api/v1`: what the platform does to a task's
// linked tracker issue as its pull request opens, merges, or parks a review.
//
// Its own controller rather than more of `PublicProvisioningController`, and the line is what the
// call is ABOUT: that file brings a workspace from "connected" to "able to run a pipeline"
// (repositories, clusters, manifest sources, what is wired). This is not setup in that sense. It is
// standing behaviour of every run the board will ever do, and the one piece of it that acts OUTSIDE
// this platform, on a ticket other people are reading.
//
// Why it is public at all: a headless caller can file a task FROM a ticket
// (`POST /api/v1/services/:serviceId/tasks` with `ticket`), and the whole point of that link is
// that the issue is where the request came from and where its outcome belongs. Whether the outcome
// ever arrives there was, until this, settable only in the SPA, so the one deployment shape that
// most needs the loop closed (no humans in the app at all) was the one that could not close it.
//
// Two rules the routes below follow, both the same ones the sibling public controllers state:
//
//  1. **Delegate to the SAME service the SPA's own controller calls.** `TrackerSettingsService` owns
//     the row, the defaults and the merge, so the two doors cannot come to disagree about what an
//     omitted field means.
//  2. **The public shape is a PROJECTION.** `TrackerSettings` is an internal wire shape that also
//     carries the filing selection (`tracker`, `jiraProjectKey`, `linearTeamId`); `/api/v1` is
//     frozen. {@link toPublicWriteback} is the seam, and it publishes the writeback half only, for
//     the reason the contract states.

/** The tracker-settings module, or the 503 naming what this deployment has not wired. */
function requireTracker<E extends AppEnv>(c: Context<E>): TrackerModule {
  return requireCapability(c.get('container').tracker, 'Issue tracker is not configured')
}

/**
 * Project the stored row onto the published shape.
 *
 * `updatedAt: 0` is how the settings service spells "no row yet" (its `get` answers the defaults at
 * that stamp), and it becomes NULL here rather than travelling as a number: a caller formatting or
 * comparing an epoch-0 timestamp reads a workspace nobody has configured as one configured in 1970,
 * and the difference is exactly what this field is for.
 */
export function toPublicWriteback(settings: TrackerSettings): PublicTrackerWritebackSettings {
  return {
    writeback: {
      commentOnPrOpen: settings.writebackCommentOnPrOpen,
      resolveOnMerge: settings.writebackResolveOnMerge,
      questionsOnPark: settings.writebackQuestionsOnPark,
    },
    updatedAt: settings.updatedAt === 0 ? null : settings.updatedAt,
  }
}

/**
 * The caller's patch as the service spells it, carrying only the actions the caller NAMED.
 *
 * Absence has to survive this mapping, which is why each key is added conditionally rather than
 * assigned `?? current`: the service merges onto the stored row, and a `false` written for an
 * omitted action would silently turn off a workspace's other two settings on every patch. That is
 * the whole difference between this route and the internal wholesale PUT.
 *
 * Exported for `PublicTrackerController.test.ts`, which pins that property directly: it is the kind
 * of mistake that leaves no trace in the response the patch itself returns.
 */
export function toWritebackPatch(
  body: UpdatePublicTrackerWritebackInput,
): Partial<TrackerWritebackFlags> {
  const patch: Partial<TrackerWritebackFlags> = {}
  const writeback = body.writeback
  if (!writeback) return patch
  if (writeback.commentOnPrOpen !== undefined) {
    patch.writebackCommentOnPrOpen = writeback.commentOnPrOpen
  }
  if (writeback.resolveOnMerge !== undefined) {
    patch.writebackResolveOnMerge = writeback.resolveOnMerge
  }
  if (writeback.questionsOnPark !== undefined) {
    patch.writebackQuestionsOnPark = writeback.questionsOnPark
  }
  return patch
}

/** `GET`/`PATCH /api/v1/tracker/writeback`. Key-authenticated in-controller, `admin` throughout. */
export function publicTrackerController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getPublicTrackerWritebackContract, async (c) => {
    const auth = await authorizeOrThrow(c, getPublicTrackerWritebackContract.minScope)
    const tracker = requireTracker(c)
    return c.json(toPublicWriteback(await tracker.service.get(auth.workspaceId)), 200)
  })

  buildHonoRoute(app, updatePublicTrackerWritebackContract, async (c) => {
    const auth = await authorizeOrThrow(c, updatePublicTrackerWritebackContract.minScope)
    const tracker = requireTracker(c)
    const settings = await tracker.service.patchWriteback(
      auth.workspaceId,
      toWritebackPatch(c.req.valid('json')),
    )
    return c.json(toPublicWriteback(settings), 200)
  })

  return app
}

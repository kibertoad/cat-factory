import { listPublicPromptFragmentsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { authorizeOrThrow } from './publicApiAuth.js'
import { requireFragmentLibrary, toPublicPromptFragment } from './fragmentCatalog.js'

// The public BEST-PRACTICE-STANDARD catalog: `GET /api/v1/prompt-fragments`.
//
// The discovery read behind `fragmentIds` on task creation, and the third of the trio a caller
// files work with (`/task-types` says what a task may BE, `/pipelines` what it may RUN, this what
// it is held TO). Its own controller rather than more of the discovery or provisioning ones: those
// answer respectively what the CALLING KEY is and what the DEPLOYMENT has wired, and this is
// neither: it is the workspace's own curated library, read at the tier merge a run resolves.
//
// Deliberately NOT cached at the edge, where the workspace-independent internal pool read carries
// an hour of `Cache-Control`. This catalog is tenant data behind a per-key workspace, so a shared
// cache is the wrong shape for it, and it MOVES: a library edit or a source resync changes it
// mid-day, and a caller told to pick from an hour-old copy would name an id the create then
// refuses. The tenant merge behind it is already cached server-side, per workspace, and invalidated
// by every tier write.
export function publicFragmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPublicPromptFragmentsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicPromptFragmentsContract.minScope)
    const library = requireFragmentLibrary(c.get('container').fragmentLibrary)
    const catalog = await library.libraryService.resolvedCatalog(auth.workspaceId)
    // Catalog order, which is the merge's own (built-in tier first, then the tenant tiers): stable
    // across calls and the same order the resolved standards reach an agent in, so a caller
    // rendering this list and a reviewer citing one are reading the same sequence.
    return c.json({ fragments: catalog.map(toPublicPromptFragment) }, 200)
  })

  return app
}

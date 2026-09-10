import { PUBLIC_MAX_PAGE_LIMIT, listPublicPromptFragmentsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { authorizeOrThrow } from './publicApiAuth.js'
import { catalogPage, requireFragmentLibrary } from './fragmentCatalog.js'
import { decodeCursor, encodeCursor } from './publicApiPaging.js'

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

/**
 * Rows per page when a caller names none. The ceiling rather than a smaller number, because a
 * catalog is read ONCE to populate a picker and most workspaces fit in a single page: defaulting
 * lower would make the common case two round trips to learn there was nothing more.
 */
const DEFAULT_FRAGMENT_PAGE = PUBLIC_MAX_PAGE_LIMIT

export function publicFragmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPublicPromptFragmentsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicPromptFragmentsContract.minScope)
    const library = requireFragmentLibrary(c.get('container').fragmentLibrary)
    const query = c.req.valid('query')
    // A malformed cursor is a 400, never a silent page 1 (see the jobs list for the rationale).
    let afterId: string | undefined
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor)
      if (!decoded) {
        return c.json({ error: { code: 'invalid_cursor', message: 'Malformed cursor' } }, 400)
      }
      afterId = decoded.id
    }
    // Catalog order is the merge's own, which is by `fragmentId`, NOT tier-grouped: an entry's
    // tier says whose standard it is, and a workspace override of a built-in keeps the id it
    // overrides, so grouping by tier would move a standard around the list on an edit that changed
    // nothing about it. Ordering by the id is also what makes the keyset cursor sound, since it is
    // the merge's own key and therefore stable under a concurrent library write.
    const page = await catalogPage(library, auth.workspaceId, {
      limit: query.limit ?? DEFAULT_FRAGMENT_PAGE,
      afterId,
    })
    const last = page.fragments[page.fragments.length - 1]
    return c.json(
      {
        fragments: page.fragments,
        // The sort key IS the id here, so the cursor carries it in both halves, keeping one
        // cursor shape across every list on this surface.
        nextCursor: page.hasMore && last ? encodeCursor(last.fragmentId, last.fragmentId) : null,
      },
      200,
    )
  })

  return app
}

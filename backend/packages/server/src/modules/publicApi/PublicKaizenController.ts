import {
  acknowledgePublicKaizenEntryContract,
  getPublicKaizenEntryContract,
  KAIZEN_ENTRY_NOT_FOUND_REASON,
  listPublicKaizenEntriesContract,
  type PublicKaizenEntry,
} from '@cat-factory/contracts'
import type { KaizenModule } from '@cat-factory/orchestration'
import { NotFoundError } from '@cat-factory/kernel'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { decodeTimeCursor, encodeCursor } from './publicApiPaging.js'
import { authorize, refuse } from './publicApiAuth.js'

// The public KAIZEN surface (`/api/v1/kaizen/entries`): the workspace's post-run gradings as a
// paginated, filterable list, one entry by id, and the acknowledgement that takes an entry off the
// backlog.
//
// The gap it closes is a shape gap rather than a missing read. Gradings were already persisted and
// already rendered, but only ONE board at a time and only newest-first up to a ceiling, which is
// what a person browsing needs and the opposite of what a continuous-improvement loop needs: it
// has to see EVERY entry exactly once, file what it finds, and come back for what is new. Neither
// half of that was expressible, because the app's reads make the caller name a run or a task first
// (the very thing the loop is trying to discover) and nothing recorded whether an entry had been
// dealt with.
//
// Three rules shape this controller:
//
//  1. **Acknowledging is `write`, not `admin`.** It records that a person read a recommendation.
//     Nothing runs, nothing merges, nothing is deleted. The same judgement the reviewer-effort tag
//     on `/api/v1/merge-records` makes, for the same reason: an integration whose whole job is
//     draining a backlog must not need a key that can also merge pull requests.
//  2. **Refusals THROW**, so this surface answers with the one `handleError` envelope carrying
//     `details.reason` and the request id. The exception is the AUTH gate, whose failure is shared
//     DATA produced by `publicApiAuth`. A malformed cursor is the second: it is produced before any
//     domain call and is the one `invalid_cursor` code every paginated list on this API answers.
//  3. **A cursor is minted from the value the query ORDERS BY**, never a second stamp, so a burst
//     of gradings sharing a millisecond (a finished run schedules one per step at once) pages
//     without dropping the ties.
// ---------------------------------------------------------------------------

/** The Kaizen module, or a 503 naming what this deployment has not wired. */
function requireKaizen<E extends AppEnv>(c: Context<E>): KaizenModule {
  return requireCapability(c.get('container').kaizen, 'Kaizen is not configured')
}

/** Rows a page returns when the caller names no `limit`. */
const DEFAULT_ENTRY_PAGE = 25

/**
 * WHO an acknowledgement is attributed to: the person the key acts for when it was minted onto
 * one, else the key itself.
 *
 * Never null in practice, and deliberately not "the key's label": a label is editable prose, while
 * both ids are stable and addressable, which is what a follow-up needs six weeks later. A personal
 * key names the person rather than the key because the key is the credential and the person is the
 * one who read the recommendation.
 */
function acknowledgedBy(auth: PublicApiKeyAuth): string {
  return auth.actsAsUserId ?? auth.keyId
}

export function publicKaizenController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // One keyset page of the workspace's entries, newest first. Every filter is pushed into SQL by
  // the repository: filtering a page in memory would return short pages, which a client reads as
  // "nearly done" while the backlog behind them is untouched.
  buildHonoRoute(app, listPublicKaizenEntriesContract, async (c) => {
    const gate = await authorize(c, listPublicKaizenEntriesContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const query = c.req.valid('query')
    const limit = query.limit ?? DEFAULT_ENTRY_PAGE
    // A malformed cursor is a 400, never a silent fall back to page 1: a client paging on a
    // corrupted cursor would otherwise re-serve the first page forever with no error to act on.
    let cursor: { createdAt: number; id: string } | undefined
    if (query.cursor) {
      const decoded = decodeTimeCursor(query.cursor)
      if (!decoded) {
        return c.json({ error: { code: 'invalid_cursor', message: 'Malformed cursor' } }, 400)
      }
      cursor = decoded
    }
    // One row beyond the page, so "is there another page" costs no second query.
    const rows = await requireKaizen(c).service.listEntries(gate.auth.workspaceId, {
      limit: limit + 1,
      ...(cursor ? { cursor } : {}),
      ...(query.acknowledged === undefined ? {} : { acknowledged: query.acknowledged }),
      ...(query.settled === undefined ? {} : { settled: query.settled }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.agentKind ? { agentKind: query.agentKind } : {}),
      ...(query.since === undefined ? {} : { since: query.since }),
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    return c.json({ entries: page, nextCursor: nextCursorFor(hasMore, last) }, 200)
  })

  // One entry by id, scoped to the key's workspace like every point read on this API.
  buildHonoRoute(app, getPublicKaizenEntryContract, async (c) => {
    const gate = await authorize(c, getPublicKaizenEntryContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const entryId = c.req.valid('param').entryId
    const entry = await requireKaizen(c).service.getEntry(gate.auth.workspaceId, entryId)
    if (!entry) {
      throw new NotFoundError('KaizenEntry', entryId, { reason: KAIZEN_ENTRY_NOT_FOUND_REASON })
    }
    return c.json(entry, 200)
  })

  // Record (or clear) the triage. The service raises the 404 for an unknown id and the 409 for an
  // entry the grader has not settled, both carrying the reason a caller branches on; refusing
  // inside it rather than pre-checking here keeps the write a single decision with no window
  // between a check and the patch.
  buildHonoRoute(app, acknowledgePublicKaizenEntryContract, async (c) => {
    const gate = await authorize(c, acknowledgePublicKaizenEntryContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const body = c.req.valid('json')
    const entry = await requireKaizen(c).service.acknowledgeEntry(
      gate.auth.workspaceId,
      c.req.valid('param').entryId,
      {
        // Absent means "acknowledge", so the ordinary call is an empty body; `false` is the
        // deliberate undo.
        acknowledged: body.acknowledged ?? true,
        note: body.note ?? null,
        actor: acknowledgedBy(gate.auth),
      },
    )
    return c.json(entry, 200)
  })

  return app
}

/**
 * The cursor for the next page, minted from the last row's `createdAt` — by construction the same
 * value the repository ordered and filtered on, never a second stamp taken here.
 */
function nextCursorFor(hasMore: boolean, last: PublicKaizenEntry | undefined): string | null {
  return hasMore && last ? encodeCursor(last.createdAt, last.entryId) : null
}

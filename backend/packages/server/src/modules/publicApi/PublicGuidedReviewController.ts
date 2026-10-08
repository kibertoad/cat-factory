import {
  askPublicGuidedReviewContract,
  deletePublicGuidedReviewContract,
  editPublicGuidedReviewDraftContract,
  getPublicGuidedReviewContract,
  getPublicGuidedReviewThreadContract,
  listPublicGuidedReviewsContract,
  openPublicGuidedReviewContract,
  openPublicGuidedReviewThreadContract,
  postPublicGuidedReviewDraftsContract,
  refreshPublicGuidedReviewContract,
  requestPublicGuidedReviewDraftsContract,
} from '@cat-factory/contracts'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import { NotFoundError } from '@cat-factory/kernel'
import type { GuidedReviewModule, GuidedReviewOwner } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { authorize, refuse } from './publicApiAuth.js'
import { decodeTimeCursor, encodeCursor } from './publicApiPaging.js'
import { SSE_MAX_MS, SSE_POLL_MS, SSE_REAUTH_MS } from './publicApiStreamRoutes.js'

// The public guided PR review surface (`/api/v1/guided-reviews`): the sessions the app's review
// window drives, so another UI can offer the same experience. Refusals THROW so they carry
// `details.reason`; only the auth gate answers with shared refusal data.

/** Rows a list returns when the caller names no `limit`. */
const DEFAULT_SESSION_PAGE = 50

function requireGuidedReview<E extends AppEnv>(c: Context<E>): GuidedReviewModule {
  return requireCapability(c.get('container').guidedReview, 'Guided PR review is not configured')
}

/**
 * Who a session belongs to when a key opens it: the person the key acts for, else the key
 * itself. A key-owned session runs on the workspace's credentials, never a person's.
 */
function owner(auth: PublicApiKeyAuth): GuidedReviewOwner {
  return auth.actsAsUserId
    ? { id: auth.actsAsUserId, kind: 'user' }
    : { id: auth.keyId, kind: 'api-key' }
}

/** The id the service checks ownership against, the same one {@link owner} stores. */
function actor(auth: PublicApiKeyAuth): string {
  return owner(auth).id
}

export function publicGuidedReviewController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, openPublicGuidedReviewContract, async (c) => {
    const gate = await authorize(c, openPublicGuidedReviewContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { service } = requireGuidedReview(c)
    const session = await service.open(gate.auth.workspaceId, owner(gate.auth), c.req.valid('json'))
    return c.json(await service.getSession(gate.auth.workspaceId, session.id), 200)
  })

  buildHonoRoute(app, listPublicGuidedReviewsContract, async (c) => {
    const gate = await authorize(c, listPublicGuidedReviewsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { repoId, prNumber, mine, limit = DEFAULT_SESSION_PAGE, cursor } = c.req.valid('query')
    // A malformed cursor is the list surface's shared `invalid_cursor`, never page 1 again.
    const after = cursor === undefined ? undefined : decodeTimeCursor(cursor)
    if (after === null) {
      return c.json({ error: { code: 'invalid_cursor', message: 'Malformed cursor' } }, 400)
    }
    // One row past the page, so "is there another page" costs no second query.
    const rows = await requireGuidedReview(c).service.pageSessions(
      gate.auth.workspaceId,
      {
        ...(repoId ? { repoId } : {}),
        ...(prNumber !== undefined ? { prNumber } : {}),
        ...(mine ? { createdBy: actor(gate.auth) } : {}),
      },
      { limit: limit + 1, ...(after ? { cursor: after } : {}) },
    )
    const sessions = rows.slice(0, limit)
    const last = sessions.at(-1)
    const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null
    return c.json({ sessions, nextCursor }, 200)
  })

  buildHonoRoute(app, getPublicGuidedReviewContract, async (c) => {
    const gate = await authorize(c, getPublicGuidedReviewContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { sessionId } = c.req.valid('param')
    return c.json(
      await requireGuidedReview(c).service.getSession(gate.auth.workspaceId, sessionId),
      200,
    )
  })

  buildHonoRoute(app, deletePublicGuidedReviewContract, async (c) => {
    const gate = await authorize(c, deletePublicGuidedReviewContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { sessionId } = c.req.valid('param')
    await requireGuidedReview(c).service.deleteSession(
      gate.auth.workspaceId,
      actor(gate.auth),
      sessionId,
    )
    return c.body(null, 204)
  })

  buildHonoRoute(app, refreshPublicGuidedReviewContract, async (c) => {
    const gate = await authorize(c, refreshPublicGuidedReviewContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { service } = requireGuidedReview(c)
    const { sessionId } = c.req.valid('param')
    await service.refresh(gate.auth.workspaceId, actor(gate.auth), sessionId)
    return c.json(await service.getSession(gate.auth.workspaceId, sessionId), 200)
  })

  buildHonoRoute(app, openPublicGuidedReviewThreadContract, async (c) => {
    const gate = await authorize(c, openPublicGuidedReviewThreadContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { sessionId } = c.req.valid('param')
    const view = await requireGuidedReview(c).service.openThread(
      gate.auth.workspaceId,
      actor(gate.auth),
      sessionId,
      c.req.valid('json'),
    )
    return c.json(view, 200)
  })

  buildHonoRoute(app, getPublicGuidedReviewThreadContract, async (c) => {
    const gate = await authorize(c, getPublicGuidedReviewThreadContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { sessionId, threadId } = c.req.valid('param')
    const view = await requireGuidedReview(c).service.getThread(
      gate.auth.workspaceId,
      sessionId,
      threadId,
    )
    return c.json(view, 200)
  })

  buildHonoRoute(app, askPublicGuidedReviewContract, async (c) => {
    const gate = await authorize(c, askPublicGuidedReviewContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { sessionId, threadId } = c.req.valid('param')
    const exchange = await requireGuidedReview(c).service.ask(
      gate.auth.workspaceId,
      actor(gate.auth),
      sessionId,
      threadId,
      c.req.valid('json'),
    )
    return c.json(exchange, 200)
  })

  buildHonoRoute(app, requestPublicGuidedReviewDraftsContract, async (c) => {
    const gate = await authorize(c, requestPublicGuidedReviewDraftsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { sessionId, threadId } = c.req.valid('param')
    const exchange = await requireGuidedReview(c).service.requestDrafts(
      gate.auth.workspaceId,
      actor(gate.auth),
      sessionId,
      threadId,
      c.req.valid('json').instructions,
    )
    return c.json(exchange, 200)
  })

  buildHonoRoute(app, editPublicGuidedReviewDraftContract, async (c) => {
    const gate = await authorize(c, editPublicGuidedReviewDraftContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { sessionId, draftId } = c.req.valid('param')
    const draft = await requireGuidedReview(c).service.editDraft(
      gate.auth.workspaceId,
      actor(gate.auth),
      sessionId,
      draftId,
      c.req.valid('json'),
    )
    return c.json(draft, 200)
  })

  buildHonoRoute(app, postPublicGuidedReviewDraftsContract, async (c) => {
    const gate = await authorize(c, postPublicGuidedReviewDraftsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const result = await requireGuidedReview(c).service.postDrafts(
      gate.auth.workspaceId,
      actor(gate.auth),
      c.req.valid('param').sessionId,
      c.req.valid('json'),
    )
    return c.json(result, 200)
  })

  registerGuidedReviewStreamRoute(app)
  return app
}

/**
 * `GET /api/v1/guided-reviews/:sessionId/events`: the session view (overview, thread summaries,
 * drafts) as a `state` frame whenever it changes, de-duplicated on the serialized payload. A
 * thread whose `pendingMessageId` clears has an answer to fetch. A bounded poll like the run
 * streams, so it is runtime-symmetric by construction; `read` scope, restated in the hand-written
 * OpenAPI entry.
 */
function registerGuidedReviewStreamRoute(app: Hono<AppEnv>): void {
  app.get('/api/v1/guided-reviews/:sessionId/events', async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const { auth } = gate
    const { service } = requireGuidedReview(c)
    const sessionId = c.req.param('sessionId')
    // Resolve before opening the stream, so an unknown session is a 404 rather than an empty one.
    const first = await service.getSession(auth.workspaceId, sessionId)
    const keys = c.get('container').publicApiKeys
    return streamSSE(c, async (stream) => {
      const startedAt = Date.now()
      let lastAuthCheck = Date.now()
      let last = ''
      let view: typeof first | null = first
      for (;;) {
        if (stream.aborted) break
        if (keys && Date.now() - lastAuthCheck > SSE_REAUTH_MS) {
          if (!(await keys.isActive(auth.keyId))) break
          lastAuthCheck = Date.now()
        }
        if (!view) {
          await stream.writeSSE({ event: 'deleted', data: JSON.stringify({ sessionId }) })
          break
        }
        const data = JSON.stringify(view)
        if (data !== last) {
          await stream.writeSSE({ event: 'state', data })
          last = data
        }
        if (Date.now() - startedAt > SSE_MAX_MS) {
          await stream.writeSSE({ event: 'timeout', data: '{}' })
          break
        }
        await stream.sleep(SSE_POLL_MS)
        view = await service.getSession(auth.workspaceId, sessionId).catch((error: unknown) => {
          if (error instanceof NotFoundError) return null
          throw error
        })
      }
    })
  })
}

import {
  askGuidedReviewContract,
  deleteGuidedReviewContract,
  editGuidedReviewDraftContract,
  getGuidedReviewContract,
  getGuidedReviewThreadContract,
  listGuidedReviewsContract,
  openGuidedReviewContract,
  openGuidedReviewThreadContract,
  postGuidedReviewDraftsContract,
  refreshGuidedReviewContract,
  requestGuidedReviewDraftsContract,
} from '@cat-factory/contracts'
import type { GuidedReviewModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability, requireUser } from '../../http/guards.js'

// Guided PR review for the SPA (docs/initiatives/guided-pr-review.md). Member tier: reading and
// exploring a pull request is everyday review work, the workspace gate's viewer write floor covers
// every write, and the service lets only a session's creator change it. Writes return at once;
// the overview and answers arrive through the `guidedReview` event.

function requireGuidedReview<E extends AppEnv>(c: Context<E>): GuidedReviewModule {
  return requireCapability(c.get('container').guidedReview, 'Guided PR review is not configured')
}

const SIGNED_IN = 'Guided PR review needs a signed-in user'

export function guidedReviewController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, openGuidedReviewContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const workspaceId = param(c, 'workspaceId')
    const session = await service.open(
      workspaceId,
      requireUser(c, SIGNED_IN).id,
      c.req.valid('json'),
    )
    return c.json(await service.getSession(workspaceId, session.id), 200)
  })

  buildHonoRoute(app, listGuidedReviewsContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const { repoId, prNumber, mine } = c.req.valid('query')
    const createdBy = mine ? requireUser(c, SIGNED_IN).id : undefined
    const sessions = await service.listSessions(param(c, 'workspaceId'), {
      ...(repoId ? { repoId } : {}),
      ...(prNumber ? { prNumber } : {}),
      ...(createdBy ? { createdBy } : {}),
    })
    return c.json(sessions, 200)
  })

  buildHonoRoute(app, getGuidedReviewContract, async (c) => {
    const { service } = requireGuidedReview(c)
    return c.json(
      await service.getSession(param(c, 'workspaceId'), c.req.valid('param').sessionId),
      200,
    )
  })

  buildHonoRoute(app, deleteGuidedReviewContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const { sessionId } = c.req.valid('param')
    await service.deleteSession(param(c, 'workspaceId'), requireUser(c, SIGNED_IN).id, sessionId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, refreshGuidedReviewContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const workspaceId = param(c, 'workspaceId')
    const { sessionId } = c.req.valid('param')
    await service.refresh(workspaceId, requireUser(c, SIGNED_IN).id, sessionId)
    return c.json(await service.getSession(workspaceId, sessionId), 200)
  })

  buildHonoRoute(app, openGuidedReviewThreadContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const { sessionId } = c.req.valid('param')
    const view = await service.openThread(
      param(c, 'workspaceId'),
      requireUser(c, SIGNED_IN).id,
      sessionId,
      c.req.valid('json'),
    )
    return c.json(view, 200)
  })

  buildHonoRoute(app, getGuidedReviewThreadContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const { sessionId, threadId } = c.req.valid('param')
    return c.json(await service.getThread(param(c, 'workspaceId'), sessionId, threadId), 200)
  })

  buildHonoRoute(app, askGuidedReviewContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const { sessionId, threadId } = c.req.valid('param')
    const exchange = await service.ask(
      param(c, 'workspaceId'),
      requireUser(c, SIGNED_IN).id,
      sessionId,
      threadId,
      c.req.valid('json'),
    )
    return c.json(exchange, 200)
  })

  buildHonoRoute(app, requestGuidedReviewDraftsContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const { sessionId, threadId } = c.req.valid('param')
    const exchange = await service.requestDrafts(
      param(c, 'workspaceId'),
      requireUser(c, SIGNED_IN).id,
      sessionId,
      threadId,
      c.req.valid('json').instructions ?? '',
    )
    return c.json(exchange, 200)
  })

  buildHonoRoute(app, editGuidedReviewDraftContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const { sessionId, draftId } = c.req.valid('param')
    const draft = await service.editDraft(
      param(c, 'workspaceId'),
      requireUser(c, SIGNED_IN).id,
      sessionId,
      draftId,
      c.req.valid('json'),
    )
    return c.json(draft, 200)
  })

  // Publishes the chosen drafts on the pull request under the caller's credential scope.
  buildHonoRoute(app, postGuidedReviewDraftsContract, async (c) => {
    const { service } = requireGuidedReview(c)
    const result = await service.postDrafts(
      param(c, 'workspaceId'),
      requireUser(c, SIGNED_IN).id,
      c.req.valid('param').sessionId,
      c.req.valid('json'),
    )
    return c.json(result, 200)
  })

  return app
}

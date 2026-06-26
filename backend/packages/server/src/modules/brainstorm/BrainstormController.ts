import {
  type BrainstormStage,
  brainstormStageSchema,
  incorporateBrainstormSchema,
  replyBrainstormItemSchema,
  resolveBrainstormExceededSchema,
  updateBrainstormItemStatusSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { BrainstormModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the brainstorm module or send a 503, returning null when unconfigured. */
function requireBrainstorm(c: Context<AppEnv>): BrainstormModule | null {
  return c.get('container').brainstorm ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Brainstorm is not configured' } }, 503)

/** Parse + validate the `:stage` path param, or null when it is not a known stage. */
function stageParam(c: Context<AppEnv>): BrainstormStage | null {
  const parsed = v.safeParse(brainstormStageSchema, param(c, 'stage'))
  return parsed.success ? parsed.output : null
}

const badStage = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'bad_request', message: 'Unknown brainstorm stage' } }, 400)

/**
 * Workspace-scoped brainstorm (structured-dialogue) endpoints, STAGE-scoped: a block may have
 * one live `requirements` session and one live `architecture` session at once. The brainstorm
 * mirror of the requirements / clarity review controllers: the initial pass runs an LLM inline
 * and returns the session; incorporation is ASYNCHRONOUS (records the intent on the parked run,
 * signals the durable driver to fold + re-run, returns at once with the `incorporating`
 * session). Item-level mutations are session-id scoped (the two stages share the store).
 * Mounted under `/workspaces/:workspaceId`.
 */
export function brainstormController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The current session for a block + stage (null when none has been run yet).
  app.get('/blocks/:blockId/brainstorm/:stage', async (c) => {
    const brainstorm = requireBrainstorm(c)
    if (!brainstorm) return unavailable(c)
    const stage = stageParam(c)
    if (!stage) return badStage(c)
    const session = await brainstorm.services[stage].getForBlock(
      param(c, 'workspaceId'),
      param(c, 'blockId'),
    )
    return c.json(session)
  })

  // Run a fresh brainstorm pass for the block + stage (replaces any prior). Routed through the
  // execution service so the off-path surface honours the task's merge-preset knobs and threads
  // in any upstream refined requirements, exactly like the gate.
  app.post('/blocks/:blockId/brainstorm/:stage', async (c) => {
    const brainstorm = requireBrainstorm(c)
    if (!brainstorm) return unavailable(c)
    const stage = stageParam(c)
    if (!stage) return badStage(c)
    const session = await c
      .get('container')
      .executionService.reviewBrainstorm(param(c, 'workspaceId'), param(c, 'blockId'), stage)
    return c.json(session, 201)
  })

  // Respond to a single option (pick / steer). Session-id scoped (stage-agnostic store).
  app.post(
    '/brainstorm-sessions/:sessionId/items/:itemId/reply',
    jsonBody(replyBrainstormItemSchema),
    async (c) => {
      const brainstorm = requireBrainstorm(c)
      if (!brainstorm) return unavailable(c)
      const session = await brainstorm.services.requirements.replyToItem(
        param(c, 'workspaceId'),
        param(c, 'sessionId'),
        param(c, 'itemId'),
        c.req.valid('json').reply,
      )
      return c.json(session)
    },
  )

  // Set an option's status (resolve / dismiss / reopen). Session-id scoped.
  app.patch(
    '/brainstorm-sessions/:sessionId/items/:itemId',
    jsonBody(updateBrainstormItemStatusSchema),
    async (c) => {
      const brainstorm = requireBrainstorm(c)
      if (!brainstorm) return unavailable(c)
      const session = await brainstorm.services.requirements.setItemStatus(
        param(c, 'workspaceId'),
        param(c, 'sessionId'),
        param(c, 'itemId'),
        c.req.valid('json').status,
      )
      return c.json(session)
    },
  )

  // Incorporate the picks ASYNCHRONOUSLY (the durable driver folds + re-runs).
  app.post(
    '/blocks/:blockId/brainstorm/:stage/incorporate',
    jsonBody(incorporateBrainstormSchema),
    async (c) => {
      const brainstorm = requireBrainstorm(c)
      if (!brainstorm) return unavailable(c)
      const stage = stageParam(c)
      if (!stage) return badStage(c)
      const session = await c
        .get('container')
        .executionService.incorporateBrainstorm(
          param(c, 'workspaceId'),
          param(c, 'blockId'),
          stage,
          c.req.valid('json').feedback,
        )
      return c.json(session)
    },
  )

  // Re-run the brainstorm against the converged direction (one more pass).
  app.post('/blocks/:blockId/brainstorm/:stage/re-review', async (c) => {
    const brainstorm = requireBrainstorm(c)
    if (!brainstorm) return unavailable(c)
    const stage = stageParam(c)
    if (!stage) return badStage(c)
    const session = await c
      .get('container')
      .executionService.reReviewBrainstorm(param(c, 'workspaceId'), param(c, 'blockId'), stage)
    return c.json(session)
  })

  // Proceed: settle the brainstorm (last converged direction wins downstream) and advance.
  app.post('/blocks/:blockId/brainstorm/:stage/proceed', async (c) => {
    const brainstorm = requireBrainstorm(c)
    if (!brainstorm) return unavailable(c)
    const stage = stageParam(c)
    if (!stage) return badStage(c)
    const session = await c
      .get('container')
      .executionService.proceedBrainstorm(param(c, 'workspaceId'), param(c, 'blockId'), stage)
    return c.json(session)
  })

  // Resolve a session that hit its iteration cap: one more round / proceed / stop-reset.
  app.post(
    '/blocks/:blockId/brainstorm/:stage/resolve-exceeded',
    jsonBody(resolveBrainstormExceededSchema),
    async (c) => {
      const brainstorm = requireBrainstorm(c)
      if (!brainstorm) return unavailable(c)
      const stage = stageParam(c)
      if (!stage) return badStage(c)
      const session = await c
        .get('container')
        .executionService.resolveBrainstormExceeded(
          param(c, 'workspaceId'),
          param(c, 'blockId'),
          stage,
          c.req.valid('json').choice,
        )
      return c.json(session)
    },
  )

  return app
}

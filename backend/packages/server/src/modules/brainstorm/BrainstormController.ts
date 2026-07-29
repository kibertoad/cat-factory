import {
  getBrainstormContract,
  incorporateBrainstormContract,
  proceedBrainstormContract,
  reReviewBrainstormContract,
  replyBrainstormItemContract,
  resolveBrainstormExceededContract,
  reviewBrainstormContract,
  updateBrainstormItemStatusContract,
} from '@cat-factory/contracts'
import type { BrainstormModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the brainstorm module, or refuse with a 503 naming what isn't wired. */
function requireBrainstorm<E extends AppEnv>(c: Context<E>): BrainstormModule {
  return requireCapability(c.get('container').brainstorm, 'Brainstorm is not configured')
}

/**
 * The brainstorm module as a REFUSAL only. These routes drive their mutations through the
 * execution service and read nothing off the module itself — but an unwired deployment must
 * still 503 rather than answer. Discarding a `requireBrainstorm` result would read as a
 * no-op statement, so the guard is named for what it does and returns `void`.
 */
function assertBrainstormWired<E extends AppEnv>(c: Context<E>): void {
  requireBrainstorm(c)
}

/**
 * Workspace-scoped brainstorm (structured-dialogue) endpoints, STAGE-scoped: a block may have
 * one live `requirements` session and one live `architecture` session at once. The brainstorm
 * mirror of the requirements / clarity review controllers: the initial pass runs an LLM inline
 * and returns the session; incorporation is ASYNCHRONOUS (records the intent on the parked run,
 * signals the durable driver to fold + re-run, returns at once with the `incorporating`
 * session). Item-level mutations are session-id scoped (the two stages share the store). The
 * `:stage` param is validated by the contract (an unknown stage is a shared 400), so the
 * controller no longer hand-parses it. Mounted under `/workspaces/:workspaceId`.
 */
export function brainstormController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The current session for a block + stage (null when none has been run yet).
  buildHonoRoute(app, getBrainstormContract, async (c) => {
    const brainstorm = requireBrainstorm(c)
    const { blockId, stage } = c.req.valid('param')
    const session = await brainstorm.services[stage].getForBlock(param(c, 'workspaceId'), blockId)
    return c.json(session, 200)
  })

  // Run a fresh brainstorm pass for the block + stage (replaces any prior). Routed through the
  // execution service so the off-path surface honours the task's merge-preset knobs and threads
  // in any upstream refined requirements, exactly like the gate.
  buildHonoRoute(app, reviewBrainstormContract, async (c) => {
    assertBrainstormWired(c)
    const { blockId, stage } = c.req.valid('param')
    const session = await c
      .get('container')
      .executionService.brainstorm.review(param(c, 'workspaceId'), blockId, stage)
    return c.json(session, 201)
  })

  // Respond to a single option (pick / steer). Session-id scoped (stage-agnostic store).
  buildHonoRoute(app, replyBrainstormItemContract, async (c) => {
    const brainstorm = requireBrainstorm(c)
    const { sessionId, itemId } = c.req.valid('param')
    const session = await brainstorm.services.requirements.replyToItem(
      param(c, 'workspaceId'),
      sessionId,
      itemId,
      c.req.valid('json').reply,
    )
    return c.json(session, 200)
  })

  // Set an option's status (resolve / dismiss / reopen). Session-id scoped.
  buildHonoRoute(app, updateBrainstormItemStatusContract, async (c) => {
    const brainstorm = requireBrainstorm(c)
    const { sessionId, itemId } = c.req.valid('param')
    const session = await brainstorm.services.requirements.setItemStatus(
      param(c, 'workspaceId'),
      sessionId,
      itemId,
      c.req.valid('json').status,
    )
    return c.json(session, 200)
  })

  // Incorporate the picks ASYNCHRONOUSLY (the durable driver folds + re-runs).
  buildHonoRoute(app, incorporateBrainstormContract, async (c) => {
    assertBrainstormWired(c)
    const { blockId, stage } = c.req.valid('param')
    const session = await c
      .get('container')
      .executionService.brainstorm.incorporate(
        param(c, 'workspaceId'),
        blockId,
        stage,
        c.req.valid('json').feedback,
      )
    return c.json(session, 200)
  })

  // Re-run the brainstorm against the converged direction (one more pass).
  buildHonoRoute(app, reReviewBrainstormContract, async (c) => {
    assertBrainstormWired(c)
    const { blockId, stage } = c.req.valid('param')
    const session = await c
      .get('container')
      .executionService.brainstorm.reReview(param(c, 'workspaceId'), blockId, stage)
    return c.json(session, 200)
  })

  // Proceed: settle the brainstorm (last converged direction wins downstream) and advance.
  buildHonoRoute(app, proceedBrainstormContract, async (c) => {
    assertBrainstormWired(c)
    const { blockId, stage } = c.req.valid('param')
    const session = await c
      .get('container')
      .executionService.brainstorm.proceed(param(c, 'workspaceId'), blockId, stage)
    return c.json(session, 200)
  })

  // Resolve a session that hit its iteration cap: one more round / proceed / stop-reset.
  buildHonoRoute(app, resolveBrainstormExceededContract, async (c) => {
    assertBrainstormWired(c)
    const { blockId, stage } = c.req.valid('param')
    const session = await c
      .get('container')
      .executionService.brainstorm.resolveExceeded(
        param(c, 'workspaceId'),
        blockId,
        stage,
        c.req.valid('json').choice,
      )
    return c.json(session, 200)
  })

  return app
}

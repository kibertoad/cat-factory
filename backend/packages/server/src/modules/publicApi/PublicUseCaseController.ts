import {
  getPublicUseCaseContract,
  invokePublicUseCaseContract,
  listPublicUseCasesContract,
} from '@cat-factory/contracts'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import type { InlineUseCaseScope } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { authorize, refuse } from './publicApiAuth.js'

// ---------------------------------------------------------------------------
// The public INLINE USE-CASE surface (`/api/v1/use-cases`): the non-container half of this API.
//
// Two reads and one write, all thin. Every rule the surface enforces (the model narrowing, the
// parameter validation, the generation bounds, the budget guard, the refusals) lives in
// `InlineUseCaseService`, so the SAME behaviour holds for any other caller of it and the
// conformance suite drives it on every runtime through this controller.
//
// Its own controller rather than three more routes on `PublicApiController`, for the reason the
// discovery controller split out: the board/job routes are built around the engine, and none of
// these touch it.
//
// The service is on the core spine rather than an optional module, so there is no capability guard
// here: a deployment with no model provider still ANSWERS discovery (with each model marked
// unavailable) and refuses only the invocation, which is the honest split. A 503 on the catalog
// would tell a wrapper the surface does not exist when what is missing is a key.
// ---------------------------------------------------------------------------

/**
 * The credential scope a request runs under: all three tiers the authenticated key carries.
 *
 * Threaded rather than reduced to the workspace id, because both things downstream reads it for are
 * tiered. The model pool draws account-scoped and user-scoped provider keys (and the acting user's
 * locally-run endpoints), so a workspace-only scope reports a model this deployment CAN serve as
 * `provider_unavailable`; and the budget guard checks the account and user ceilings only when the
 * scope names them, so a workspace-only scope lets an account past its own limit keep generating.
 */
function scopeOf(auth: PublicApiKeyAuth): InlineUseCaseScope {
  return {
    workspaceId: auth.workspaceId,
    accountId: auth.accountId,
    // Null for a key minted with no identity, which is a real state rather than a missing value:
    // such a key simply has no personal keys to draw on, and `excludesUserScopedModels` on
    // `GET /api/v1/models` is where that omission is REPORTED.
    userId: auth.actsAsUserId,
  }
}

export function publicUseCaseController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The catalog: what this deployment will generate, on which models, from which parameters.
  buildHonoRoute(app, listPublicUseCasesContract, async (c) => {
    const gate = await authorize(c, listPublicUseCasesContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const useCases = await c.get('container').inlineUseCases.list(scopeOf(gate.auth))
    return c.json({ useCases }, 200)
  })

  // One use case by id, for a caller that already holds one.
  buildHonoRoute(app, getPublicUseCaseContract, async (c) => {
    const gate = await authorize(c, getPublicUseCaseContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const useCase = await c
      .get('container')
      .inlineUseCases.get(scopeOf(gate.auth), c.req.valid('param').useCaseId)
    return c.json(useCase, 200)
  })

  // Run it. Synchronous: one inline model call, so there is no job to poll.
  buildHonoRoute(app, invokePublicUseCaseContract, async (c) => {
    const gate = await authorize(c, invokePublicUseCaseContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const body = c.req.valid('json')
    const invocation = await c.get('container').inlineUseCases.invoke({
      scope: scopeOf(gate.auth),
      useCaseId: c.req.valid('param').useCaseId,
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.parameters === undefined ? {} : { parameters: body.parameters }),
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.maxOutputTokens === undefined ? {} : { maxOutputTokens: body.maxOutputTokens }),
    })
    return c.json(invocation, 200)
  })

  return app
}

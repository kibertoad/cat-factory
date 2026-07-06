import {
  answerInitiativeQuestionContract,
  cancelInitiativeContract,
  continueInitiativePlanningContract,
  createInitiativeContract,
  dismissInitiativeFollowUpContract,
  getInitiativeByBlockContract,
  getInitiativeContract,
  initiativePresetInputsSchema,
  listInitiativesContract,
  pauseInitiativeContract,
  probeInitiativePresetContract,
  proceedInitiativePlanningContract,
  promoteInitiativeFollowUpContract,
  resumeInitiativeContract,
  updateInitiativeItemContract,
  updateInitiativePolicyContract,
} from '@cat-factory/contracts'
import { getInitiativePreset } from '@cat-factory/kernel'
import type { InitiativesModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the initiatives module or send a 503, returning null when unconfigured. */
function requireInitiatives<E extends AppEnv>(c: Context<E>): InitiativesModule | null {
  return c.get('container').initiatives ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Initiatives are not configured' } }, 503)

/**
 * Workspace-scoped initiative endpoints: create (the initiative-level board block +
 * its empty entity in one call — the Create Initiative button's target) and the
 * reads the tracker window / inspector load from. The planning pipeline itself is
 * started through the ordinary execution endpoints against the initiative block
 * (`pl_initiative` — enforced by the engine's runnable guard). Mounted under
 * `/workspaces/:workspaceId`.
 */
export function initiativeController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, createInitiativeContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const created = await initiatives.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(created, 201)
  })

  buildHonoRoute(app, listInitiativesContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    return c.json(await initiatives.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, getInitiativeContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { initiativeId } = c.req.valid('param')
    return c.json(await initiatives.service.get(param(c, 'workspaceId'), initiativeId), 200)
  })

  buildHonoRoute(app, getInitiativeByBlockContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await initiatives.service.getByBlock(param(c, 'workspaceId'), blockId), 200)
  })

  // Run a preset's repo-detection PREFILL probe against a frame's repo, to seed the create form.
  // Best-effort by contract: `{}` (descriptor defaults) whenever the preset has no `detect` hook,
  // GitHub isn't wired, the frame isn't under a linked repo, or `detect` fails — so the form
  // never blocks on it. Resolves the frame's repo through the same `resolveRunRepoContext` seam
  // the service-spec read uses, so it is runtime-symmetric (both facades wire the resolver).
  buildHonoRoute(app, probeInitiativePresetContract, async (c) => {
    const { presetId } = c.req.valid('param')
    const { frameId } = c.req.valid('json')
    const detect = getInitiativePreset(presetId)?.detect
    if (!detect) return c.json({}, 200)
    const resolve = c.get('container').resolveRunRepoContext
    if (!resolve) return c.json({}, 200)
    let ctx
    try {
      ctx = await resolve(param(c, 'workspaceId'), frameId)
    } catch {
      // A frame under no linked repo throws in the resolver; treat as "no prefill".
      return c.json({}, 200)
    }
    if (!ctx) return c.json({}, 200)
    try {
      const detected = await detect(ctx.repo)
      // Defensive parse: `detect` is trusted backend code but a bug returning an oversized /
      // malformed value must degrade to descriptor defaults, never surface to the form.
      const parsed = v.safeParse(initiativePresetInputsSchema, detected)
      return c.json(parsed.success ? parsed.output : {}, 200)
    } catch {
      return c.json({}, 200)
    }
  })

  // ---- Interactive planning (slice 2) --------------------------------------
  // Drive the parked interviewer gate from the planning Q&A window. `answer` records one
  // answer (no run resume); `continue`/`proceed` resume the parked run, running the (slow)
  // interviewer LLM in the durable driver. All go through `executionService.initiativeInterview`
  // (undefined when no initiative store is wired → 503), and return the updated initiative.
  const requirePlanning = <E extends AppEnv>(c: Context<E>) =>
    c.get('container').executionService.initiativeInterview ?? null

  buildHonoRoute(app, answerInitiativeQuestionContract, async (c) => {
    const planning = requirePlanning(c)
    if (!planning) return unavailable(c)
    const { blockId } = c.req.valid('param')
    const { questionId, answer } = c.req.valid('json')
    return c.json(await planning.answer(param(c, 'workspaceId'), blockId, questionId, answer), 200)
  })

  buildHonoRoute(app, continueInitiativePlanningContract, async (c) => {
    const planning = requirePlanning(c)
    if (!planning) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await planning.continue(param(c, 'workspaceId'), blockId), 200)
  })

  buildHonoRoute(app, proceedInitiativePlanningContract, async (c) => {
    const planning = requirePlanning(c)
    if (!planning) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await planning.proceed(param(c, 'workspaceId'), blockId), 200)
  })

  // ---- Execution loop controls (slice 3) -----------------------------------
  // Pause / resume / cancel an executing initiative. Each is a CAS transition on the entity
  // (the loop skips a non-`executing` initiative on its next sweep) and returns the updated
  // entity so the SPA patches its cache.

  buildHonoRoute(app, pauseInitiativeContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await initiatives.service.pause(param(c, 'workspaceId'), blockId), 200)
  })

  buildHonoRoute(app, resumeInitiativeContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await initiatives.service.resume(param(c, 'workspaceId'), blockId), 200)
  })

  buildHonoRoute(app, cancelInitiativeContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await initiatives.service.cancel(param(c, 'workspaceId'), blockId), 200)
  })

  // ---- Follow-up triage + item/policy editing (slice 4) --------------------
  // Mid-flight human curation of an executing initiative, keyed by initiative id. Each rides the
  // service's rev-CAS single-writer path (so a human edit and a live tick can't clobber each
  // other) and returns the updated entity for the SPA to patch.

  buildHonoRoute(app, promoteInitiativeFollowUpContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { initiativeId, followUpId } = c.req.valid('param')
    const updated = await initiatives.service.promoteFollowUp(
      param(c, 'workspaceId'),
      initiativeId,
      followUpId,
      c.req.valid('json'),
    )
    return c.json(updated, 200)
  })

  buildHonoRoute(app, dismissInitiativeFollowUpContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { initiativeId, followUpId } = c.req.valid('param')
    const updated = await initiatives.service.dismissFollowUp(
      param(c, 'workspaceId'),
      initiativeId,
      followUpId,
    )
    return c.json(updated, 200)
  })

  buildHonoRoute(app, updateInitiativeItemContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { initiativeId, itemId } = c.req.valid('param')
    const updated = await initiatives.service.updateItem(
      param(c, 'workspaceId'),
      initiativeId,
      itemId,
      c.req.valid('json'),
    )
    return c.json(updated, 200)
  })

  buildHonoRoute(app, updateInitiativePolicyContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { initiativeId } = c.req.valid('param')
    const updated = await initiatives.service.updatePolicy(
      param(c, 'workspaceId'),
      initiativeId,
      c.req.valid('json'),
    )
    return c.json(updated, 200)
  })

  return app
}

import {
  listLocalModelEndpointsContract,
  localRunnerSchema,
  removeLocalModelEndpointContract,
  testLocalModelEndpointContract,
  upsertLocalModelEndpointContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability, requireUser } from '../../http/guards.js'

// Per-USER locally-run model endpoints (Ollama / LM Studio / llama.cpp / vLLM / custom
// OpenAI-compatible runners). A runner lives on the user's own machine, so endpoints are
// scoped to the signed-in user — mounted at the root (not under a workspace) and require
// a signed-in user, like personal subscriptions. The optional bearer key is write-only.

/** Resolve the local model-runner store, or refuse with a 503 naming what isn't wired. */
function requireEndpoints<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    c.get('container').localModelEndpoints,
    'Local model runner storage is not configured',
  )
}

/** The signed-in caller, or a 401 wording the prompt for what this controller manages. */
function requireSignedIn<E extends AppEnv>(c: Context<E>) {
  return requireUser(c, 'Sign in to manage local model runners')
}

/** The same 401, for a route that needs a signed-in caller but reads nothing off them. */
function assertSignedIn<E extends AppEnv>(c: Context<E>): void {
  requireSignedIn(c)
}

/**
 * Drop the user's cached local-model declarations after a write commits, so the next dispatch
 * resolves the model list and the modalities they just set rather than the TTL's stale copy.
 *
 * These two routes are the ONLY writers of the row, which is what makes an invalidation here the
 * whole coherence story for the run path's read.
 */
async function invalidateDeclarations<E extends AppEnv>(c: Context<E>, userId: string) {
  await c.get('container').caches.localModelDeclarations.invalidate(userId, userId)
}

export function localModelEndpointController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listLocalModelEndpointsContract, async (c) => {
    const local = requireEndpoints(c)
    const user = requireSignedIn(c)
    return c.json({ endpoints: await local.list(user.id) }, 200)
  })

  buildHonoRoute(app, upsertLocalModelEndpointContract, async (c) => {
    const local = requireEndpoints(c)
    const user = requireSignedIn(c)
    const provider = v.parse(localRunnerSchema, c.req.valid('param').provider)
    const body = c.req.valid('json')
    const endpoint = await local.upsert(user.id, { ...body, provider })
    await invalidateDeclarations(c, user.id)
    return c.json(endpoint, 201)
  })

  buildHonoRoute(app, removeLocalModelEndpointContract, async (c) => {
    const local = requireEndpoints(c)
    const user = requireSignedIn(c)
    const provider = v.parse(localRunnerSchema, c.req.valid('param').provider)
    await local.remove(user.id, provider)
    await invalidateDeclarations(c, user.id)
    return c.body(null, 204)
  })

  // Probe a runner's `/models` server-side so the UI can validate the URL + list models.
  buildHonoRoute(app, testLocalModelEndpointContract, async (c) => {
    const local = requireEndpoints(c)
    assertSignedIn(c)
    return c.json(await local.testConnection(c.req.valid('json')), 200)
  })

  return app
}

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
import type { AppEnv } from '../../http/env.js'
import { requireCapability, requireUser } from '../../http/guards.js'

// Per-USER locally-run model endpoints (Ollama / LM Studio / llama.cpp / vLLM / custom
// OpenAI-compatible runners). A runner lives on the user's own machine, so endpoints are
// scoped to the signed-in user — mounted at the root (not under a workspace) and require
// a signed-in user, like personal subscriptions. The optional bearer key is write-only.

export function localModelEndpointController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listLocalModelEndpointsContract, async (c) => {
    const local = requireCapability(
      c.get('container').localModelEndpoints,
      'Local model runner storage is not configured',
    )
    const user = requireUser(c, 'Sign in to manage local model runners')
    return c.json({ endpoints: await local.list(user.id) }, 200)
  })

  buildHonoRoute(app, upsertLocalModelEndpointContract, async (c) => {
    const local = requireCapability(
      c.get('container').localModelEndpoints,
      'Local model runner storage is not configured',
    )
    const user = requireUser(c, 'Sign in to manage local model runners')
    const provider = v.parse(localRunnerSchema, c.req.valid('param').provider)
    const body = c.req.valid('json')
    const endpoint = await local.upsert(user.id, { ...body, provider })
    return c.json(endpoint, 201)
  })

  buildHonoRoute(app, removeLocalModelEndpointContract, async (c) => {
    const local = requireCapability(
      c.get('container').localModelEndpoints,
      'Local model runner storage is not configured',
    )
    const user = requireUser(c, 'Sign in to manage local model runners')
    const provider = v.parse(localRunnerSchema, c.req.valid('param').provider)
    await local.remove(user.id, provider)
    return c.body(null, 204)
  })

  // Probe a runner's `/models` server-side so the UI can validate the URL + list models.
  buildHonoRoute(app, testLocalModelEndpointContract, async (c) => {
    const local = requireCapability(
      c.get('container').localModelEndpoints,
      'Local model runner storage is not configured',
    )
    requireUser(c, 'Sign in to manage local model runners')
    return c.json(await local.testConnection(c.req.valid('json')), 200)
  })

  return app
}

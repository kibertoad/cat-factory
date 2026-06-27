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

// Per-USER locally-run model endpoints (Ollama / LM Studio / llama.cpp / vLLM / custom
// OpenAI-compatible runners). A runner lives on the user's own machine, so endpoints are
// scoped to the signed-in user — mounted at the root (not under a workspace) and require
// a signed-in user, like personal subscriptions. The optional bearer key is write-only.

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unauthorized', message: 'Sign in to manage local model runners' } }, 401)

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Local model runner storage is not configured' } },
    503,
  )

export function localModelEndpointController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listLocalModelEndpointsContract, async (c) => {
    const local = c.get('container').localModelEndpoints
    if (!local) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json({ endpoints: await local.list(user.id) }, 200)
  })

  buildHonoRoute(app, upsertLocalModelEndpointContract, async (c) => {
    const local = c.get('container').localModelEndpoints
    if (!local) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const provider = v.parse(localRunnerSchema, c.req.valid('param').provider)
    const body = c.req.valid('json')
    const endpoint = await local.upsert(user.id, { ...body, provider })
    return c.json(endpoint, 201)
  })

  buildHonoRoute(app, removeLocalModelEndpointContract, async (c) => {
    const local = c.get('container').localModelEndpoints
    if (!local) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const provider = v.parse(localRunnerSchema, c.req.valid('param').provider)
    await local.remove(user.id, provider)
    return c.body(null, 204)
  })

  // Probe a runner's `/models` server-side so the UI can validate the URL + list models.
  buildHonoRoute(app, testLocalModelEndpointContract, async (c) => {
    const local = c.get('container').localModelEndpoints
    if (!local) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json(await local.testConnection(c.req.valid('json')), 200)
  })

  return app
}

import {
  storeUserSecretSchema,
  testUserSecretSchema,
  userSecretKindSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

// Per-USER generic secrets (a GitHub PAT today; future repository/provider tokens as
// new kinds). Scoped to the signed-in user — mounted at the root (not under a
// workspace) and require a signed-in user, like personal subscriptions / local model
// runners. The secret is write-only; only status metadata is returned.

const signInRequired = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unauthorized', message: 'Sign in to manage your secrets' } }, 401)

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'User secret storage is not configured' } }, 503)

export function userSecretController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/user-secrets', async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json({ secrets: await store.list(user.id), descriptors: store.describeAll() })
  })

  app.get('/user-secrets/:kind/descriptor', async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const kind = v.parse(userSecretKindSchema, param(c, 'kind'))
    const descriptor = store.describe(kind)
    if (!descriptor)
      return c.json({ error: { code: 'not_found', message: 'Unknown secret kind' } }, 404)
    return c.json(descriptor)
  })

  app.post('/user-secrets/:kind', jsonBody(storeUserSecretSchema), async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const kind = v.parse(userSecretKindSchema, param(c, 'kind'))
    return c.json(await store.store(user.id, kind, c.req.valid('json')), 201)
  })

  app.delete('/user-secrets/:kind', async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const kind = v.parse(userSecretKindSchema, param(c, 'kind'))
    await store.remove(user.id, kind)
    return c.body(null, 204)
  })

  // Probe a (not-yet-saved) secret server-side so the UI can validate before save.
  app.post('/user-secrets/:kind/test', jsonBody(testUserSecretSchema), async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const kind = v.parse(userSecretKindSchema, param(c, 'kind'))
    return c.json(await store.testConnection(kind, c.req.valid('json')))
  })

  return app
}

import {
  getUserSecretDescriptorContract,
  listUserSecretsContract,
  removeUserSecretContract,
  storeUserSecretContract,
  testUserSecretContract,
  userSecretKindSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

// Per-USER generic secrets (a GitHub PAT today; future repository/provider tokens as
// new kinds). Scoped to the signed-in user — mounted at the root (not under a
// workspace) and require a signed-in user, like personal subscriptions / local model
// runners. The secret is write-only; only status metadata is returned.

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unauthorized', message: 'Sign in to manage your secrets' } }, 401)

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'User secret storage is not configured' } }, 503)

export function userSecretController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listUserSecretsContract, async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json({ secrets: await store.list(user.id), descriptors: store.describeAll() }, 200)
  })

  buildHonoRoute(app, getUserSecretDescriptorContract, async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const kind = v.parse(userSecretKindSchema, c.req.valid('param').kind)
    const descriptor = store.describe(kind)
    if (!descriptor)
      return c.json({ error: { code: 'not_found', message: 'Unknown secret kind' } }, 404)
    return c.json(descriptor, 200)
  })

  buildHonoRoute(app, storeUserSecretContract, async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const kind = v.parse(userSecretKindSchema, c.req.valid('param').kind)
    return c.json(await store.store(user.id, kind, c.req.valid('json')), 201)
  })

  buildHonoRoute(app, removeUserSecretContract, async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const kind = v.parse(userSecretKindSchema, c.req.valid('param').kind)
    await store.remove(user.id, kind)
    // Revoke the fail-closed access cache too: without their PAT the user no longer has
    // personal-repo access, so their recorded grants must stop revealing those frames.
    if (kind === 'github_pat') await c.get('container').userRepoAccess?.removeForUser(user.id)
    return c.body(null, 204)
  })

  // Probe a (not-yet-saved) secret server-side so the UI can validate before save.
  buildHonoRoute(app, testUserSecretContract, async (c) => {
    const store = c.get('container').userSecrets
    if (!store) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const kind = v.parse(userSecretKindSchema, c.req.valid('param').kind)
    return c.json(await store.testConnection(kind, c.req.valid('json')), 200)
  })

  return app
}

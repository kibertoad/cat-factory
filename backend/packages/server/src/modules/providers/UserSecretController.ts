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
import { requireCapability, requireUser } from '../../http/guards.js'

// Per-USER generic secrets (a GitHub PAT today; future repository/provider tokens as
// new kinds). Scoped to the signed-in user — mounted at the root (not under a
// workspace) and require a signed-in user, like personal subscriptions / local model
// runners. The secret is write-only; only status metadata is returned.

/** Resolve the per-user secret store, or refuse with a 503 naming what isn't wired. */
function requireUserSecrets<E extends AppEnv>(c: Context<E>) {
  return requireCapability(c.get('container').userSecrets, 'User secret storage is not configured')
}

/** The signed-in caller, or a 401 wording the prompt for what this controller manages. */
function requireSignedIn<E extends AppEnv>(c: Context<E>) {
  return requireUser(c, 'Sign in to manage your secrets')
}

/** The same 401, for a route that needs a signed-in caller but reads nothing off them. */
function assertSignedIn<E extends AppEnv>(c: Context<E>): void {
  requireSignedIn(c)
}

export function userSecretController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listUserSecretsContract, async (c) => {
    const store = requireUserSecrets(c)
    const user = requireSignedIn(c)
    return c.json({ secrets: await store.list(user.id), descriptors: store.describeAll() }, 200)
  })

  buildHonoRoute(app, getUserSecretDescriptorContract, async (c) => {
    const store = requireUserSecrets(c)
    assertSignedIn(c)
    const kind = v.parse(userSecretKindSchema, c.req.valid('param').kind)
    const descriptor = store.describe(kind)
    if (!descriptor)
      return c.json({ error: { code: 'not_found', message: 'Unknown secret kind' } }, 404)
    return c.json(descriptor, 200)
  })

  buildHonoRoute(app, storeUserSecretContract, async (c) => {
    const store = requireUserSecrets(c)
    const user = requireSignedIn(c)
    const kind = v.parse(userSecretKindSchema, c.req.valid('param').kind)
    return c.json(await store.store(user.id, kind, c.req.valid('json')), 201)
  })

  buildHonoRoute(app, removeUserSecretContract, async (c) => {
    const store = requireUserSecrets(c)
    const user = requireSignedIn(c)
    const kind = v.parse(userSecretKindSchema, c.req.valid('param').kind)
    await store.remove(user.id, kind)
    // Revoke the fail-closed access cache too: without their PAT the user no longer has
    // personal-repo access, so their recorded grants must stop revealing those frames.
    if (kind === 'github_pat') await c.get('container').userRepoAccess?.removeForUser(user.id)
    return c.body(null, 204)
  })

  // Probe a (not-yet-saved) secret server-side so the UI can validate before save.
  buildHonoRoute(app, testUserSecretContract, async (c) => {
    const store = requireUserSecrets(c)
    assertSignedIn(c)
    const kind = v.parse(userSecretKindSchema, c.req.valid('param').kind)
    return c.json(await store.testConnection(kind, c.req.valid('json')), 200)
  })

  return app
}

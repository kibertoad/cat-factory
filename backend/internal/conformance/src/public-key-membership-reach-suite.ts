import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from './harness.js'

// Cross-runtime conformance for a public-API key that follows its person's memberships: its reach
// is whatever the bound person can act in on each call, never a stored list, and its scope in each
// workspace is lowered to what their role there allows. What a facade could get wrong is the chain
// from the stored flag, through the per-call resolution, to a membership write landing on the very
// next call, so the suite drives memberships over the real routes on both stores.
//
// Runs auth-ENABLED: a key bound to a person needs a signed-in person to mint it.

interface Me {
  workspaceId: string
  workspaceIds: string[] | null
  followsMemberships: boolean
  scope: string
}
interface Minted {
  key: { id: string; workspaceIds: string[] | null; followsMemberships: boolean }
  secret: string
}
interface Refusal {
  error: { code: string; details?: { reason?: string } }
}

const WORKSPACE_HEADER = 'x-cat-factory-workspace'

export function definePublicKeyMembershipReachSuite(harness: ConformanceHarness): void {
  describe(`[${harness.name}] public-API key following memberships`, () => {
    let seq = 0
    const uniq = () => {
      seq += 1
      return `${harness.name}-follow-${seq}-${Math.floor(Math.random() * 1e9)}`
    }
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

    /** An account with an admin and a developer, boards W1 and W2 open to it, and W3 restricted. */
    async function scenario(app: ConformanceApp) {
      const tag = uniq()
      const { accountId, ownerUserId: admin } = await app.onboarding().makeOrgOwner(`follow-${tag}`)
      const dev = (
        await app.onboarding().users.findOrCreateByIdentity('github', `follow-dev-${tag}`, {
          name: 'Developer',
          email: `follow-dev-${tag}@example.com`,
        })
      ).id
      await app.onboarding().addAccountMember(accountId, admin, dev, ['developer'])
      const board = async (name: string) =>
        (await app.createWorkspaceInAccount(accountId, admin, { name: `${name} ${tag}` })).workspace
          .id
      const [w1, w2, w3] = [await board('W1'), await board('W2'), await board('W3')]
      const adminAuth = bearer(await app.session({ id: admin }))
      const devAuth = bearer(await app.session({ id: dev }))
      const restricted = await app.call(
        'PUT',
        `/workspaces/${w3}/access-mode`,
        { accessMode: 'restricted' },
        adminAuth,
      )
      expect(restricted.status).toBe(200)
      return { accountId, admin, dev, w1, w2, w3, adminAuth, devAuth }
    }

    async function mint(
      app: ConformanceApp,
      workspaceId: string,
      auth: Record<string, string>,
      body: Record<string, unknown>,
    ) {
      return app.call<Minted & Refusal>(
        'POST',
        `/workspaces/${workspaceId}/public-api-keys`,
        { label: 'conformance-follow', ...body },
        auth,
      )
    }

    const me = (app: ConformanceApp, key: Record<string, string>, workspaceId?: string) =>
      app.call<Me & Refusal>(
        'GET',
        '/api/v1/me',
        undefined,
        workspaceId === undefined ? key : { ...key, [WORKSPACE_HEADER]: workspaceId },
      )

    it('lets a developer mint one, and reaches the boards they can act in on each call', async () => {
      const app = harness.makeApp()
      const { dev, w1, w2, w3, adminAuth, devAuth } = await scenario(app)
      const minted = await mint(app, w1, devAuth, {
        scope: 'decide',
        actsAsSelf: true,
        followsMemberships: true,
      })
      expect(minted.status).toBe(201)
      expect(minted.body.key).toMatchObject({ workspaceIds: [], followsMemberships: true })
      const key = bearer(minted.body.secret)

      const open = await me(app, key, w2)
      expect(open.status).toBe(200)
      expect(open.body).toMatchObject({ workspaceId: w2, followsMemberships: true })
      expect(open.body.workspaceIds).toEqual([w1, w2].sort())

      // A restricted board they hold no row on answers exactly like one that does not exist.
      const closed = await me(app, key, w3)
      expect(closed.status).toBe(404)
      expect(closed.body.error.details?.reason).toBe('workspace_not_found')

      // Granted on the next call, with nothing re-minted.
      const add = await app.call(
        'POST',
        `/workspaces/${w3}/members`,
        { userId: dev, role: 'viewer' },
        adminAuth,
      )
      expect(add.status).toBe(201)
      const granted = await me(app, key, w3)
      expect(granted.status).toBe(200)
      expect(granted.body.workspaceIds).toEqual([w1, w2, w3].sort())
      const reach = await app.call<{ workspaceIds: string[]; followsMemberships: boolean }>(
        'GET',
        '/api/v1/directory/reach',
        undefined,
        key,
      )
      expect(reach.body).toMatchObject({
        workspaceIds: [w1, w2, w3].sort(),
        followsMemberships: true,
      })

      // And taken away on the next call.
      const remove = await app.call(
        'DELETE',
        `/workspaces/${w3}/members/${dev}`,
        undefined,
        adminAuth,
      )
      expect(remove.status).toBe(204)
      expect((await me(app, key, w3)).status).toBe(404)
    })

    it("acts in each board with no more than its person's role there allows", async () => {
      const app = harness.makeApp()
      const { dev, w1, w3, adminAuth, devAuth } = await scenario(app)
      await app.call(
        'POST',
        `/workspaces/${w3}/members`,
        { userId: dev, role: 'viewer' },
        adminAuth,
      )
      const minted = await mint(app, w1, devAuth, {
        scope: 'admin',
        actsAsSelf: true,
        followsMemberships: true,
      })
      expect(minted.status).toBe(201)
      const key = bearer(minted.body.secret)

      expect((await me(app, key, w1)).body.scope).toBe('decide')
      expect((await me(app, key, w3)).body.scope).toBe('read')
      // Listing keys takes `admin`, which a developer is not in either board.
      const keys = await app.call<Refusal>('GET', '/api/v1/keys', undefined, {
        ...key,
        [WORKSPACE_HEADER]: w1,
      })
      expect(keys.status).toBe(403)
      expect(keys.body.error.code).toBe('insufficient_scope')
    })

    it('stops authenticating once its person can act in none of the account', async () => {
      const app = harness.makeApp()
      const { dev, w1, w2, w3, adminAuth, devAuth } = await scenario(app)
      for (const workspaceId of [w1, w2]) {
        await app.call(
          'PUT',
          `/workspaces/${workspaceId}/access-mode`,
          { accessMode: 'restricted' },
          adminAuth,
        )
      }
      await app.call(
        'POST',
        `/workspaces/${w3}/members`,
        { userId: dev, role: 'member' },
        adminAuth,
      )
      const minted = await mint(app, w3, devAuth, {
        scope: 'read',
        actsAsSelf: true,
        followsMemberships: true,
      })
      expect(minted.status).toBe(201)
      const key = bearer(minted.body.secret)
      expect((await me(app, key)).body.workspaceId).toBe(w3)

      await app.call('DELETE', `/workspaces/${w3}/members/${dev}`, undefined, adminAuth)
      expect((await me(app, key)).status).toBe(401)
    })

    it('refuses to follow nobody, or to name workspaces as well', async () => {
      const app = harness.makeApp()
      const { w1, w2, devAuth, adminAuth } = await scenario(app)
      const unbound = await mint(app, w1, adminAuth, { followsMemberships: true })
      expect(unbound.status).toBe(422)
      expect(unbound.body.error.details?.reason).toBe('follows_memberships_requires_person')

      const both = await mint(app, w1, devAuth, {
        actsAsSelf: true,
        followsMemberships: true,
        workspaceIds: [w1, w2],
      })
      expect(both.status).toBe(422)
      expect(both.body.error.details?.reason).toBe('follows_memberships_with_workspaces')
    })

    it('is listed and revoked by its person in any board, and by an account admin', async () => {
      const app = harness.makeApp()
      const { w1, w2, adminAuth, devAuth } = await scenario(app)
      const minted = await mint(app, w1, devAuth, {
        scope: 'read',
        actsAsSelf: true,
        followsMemberships: true,
      })
      const id = minted.body.key.id
      const listed = async (workspaceId: string, auth: Record<string, string>) =>
        (
          await app.call<{ keys: Array<{ id: string }> }>(
            'GET',
            `/workspaces/${workspaceId}/public-api-keys`,
            undefined,
            auth,
          )
        ).body.keys.map((key) => key.id)
      expect(await listed(w2, devAuth)).toEqual([id])
      expect(await listed(w2, adminAuth)).toContain(id)

      const revoked = await app.call(
        'DELETE',
        `/workspaces/${w2}/public-api-keys/${id}`,
        undefined,
        devAuth,
      )
      expect(revoked.status).toBe(204)
      expect((await me(app, bearer(minted.body.secret), w1)).status).toBe(401)
    })
  })
}

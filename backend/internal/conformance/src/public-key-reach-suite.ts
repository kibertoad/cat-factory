import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from './harness.js'

// Cross-runtime conformance for account-level public-API keys (docs/initiatives/directory-sync.md,
// slice 2): a key belongs to an account, may be limited to some of its workspaces, and each
// workspace-scoped call names the workspace it acts on. What a facade could get wrong, and what a
// unit test over a fake container cannot see, is the end-to-end chain: the grant rows written on
// mint, the per-request resolution reading them back, the account boundary on an unrestricted key,
// and the workspace cascade dropping a deleted board's grant.
//
// Runs auth-ENABLED, beside the RBAC suite: widening a key past one board takes an account admin,
// which a dev-open harness has no signed-in user to be.

interface Me {
  workspaceId: string
  workspaceIds: string[] | null
}
interface Minted {
  key: { id: string; workspaceId: string; workspaceIds: string[] | null }
  secret: string
}
interface Refusal {
  error: { code: string; details?: { reason?: string } }
}

const WORKSPACE_HEADER = 'x-cat-factory-workspace'

export function definePublicKeyReachSuite(harness: ConformanceHarness): void {
  describe(`[${harness.name}] public-API key reach`, () => {
    let seq = 0
    const uniq = () => {
      seq += 1
      return `${harness.name}-keys-${seq}-${Math.floor(Math.random() * 1e9)}`
    }
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

    /** An org with an admin, a plain member, and two boards W1 and W2. */
    async function scenario(app: ConformanceApp) {
      const tag = uniq()
      const { accountId, ownerUserId: admin } = await app.onboarding().makeOrgOwner(`keys-${tag}`)
      const member = (
        await app.onboarding().users.findOrCreateByIdentity('github', `keys-member-${tag}`, {
          name: 'Member',
          email: `keys-member-${tag}@example.com`,
        })
      ).id
      await app.onboarding().addAccountMember(accountId, admin, member, ['developer'])
      const w1 = (await app.createWorkspaceInAccount(accountId, admin, { name: `W1 ${tag}` }))
        .workspace.id
      const w2 = (await app.createWorkspaceInAccount(accountId, admin, { name: `W2 ${tag}` }))
        .workspace.id
      const adminAuth = bearer(await app.session({ id: admin }))
      return { accountId, admin, member, w1, w2, adminAuth }
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
        { label: 'conformance-reach', ...body },
        auth,
      )
    }

    it('resolves the workspace per request for an account-wide key, inside its account only', async () => {
      const app = harness.makeApp()
      const { w1, w2, adminAuth } = await scenario(app)
      const other = await scenario(app)
      const minted = await mint(app, w1, adminAuth, { scope: 'read', workspaceIds: null })
      expect(minted.status).toBe(201)
      expect(minted.body.key.workspaceIds).toBeNull()
      const key = bearer(minted.body.secret)

      const unnamed = await app.call<Refusal>('GET', '/api/v1/me', undefined, key)
      expect(unnamed.status).toBe(422)
      expect(unnamed.body.error.details?.reason).toBe('workspace_required')

      const named = await app.call<Me>('GET', '/api/v1/me', undefined, {
        ...key,
        [WORKSPACE_HEADER]: w2,
      })
      expect(named.status).toBe(200)
      expect(named.body).toMatchObject({ workspaceId: w2, workspaceIds: null })

      // A board in another account answers exactly like one that does not exist.
      for (const workspaceId of [other.w1, 'ws_does_not_exist']) {
        const foreign = await app.call<Refusal>('GET', '/api/v1/me', undefined, {
          ...key,
          [WORKSPACE_HEADER]: workspaceId,
        })
        expect(foreign.status).toBe(404)
        expect(foreign.body.error.details?.reason).toBe('workspace_not_found')
      }
    })

    it('keeps a single-workspace key working with no header, and refuses it any other board', async () => {
      const app = harness.makeApp()
      const { w1, w2, adminAuth } = await scenario(app)
      const minted = await mint(app, w1, adminAuth, { scope: 'read' })
      expect(minted.status).toBe(201)
      expect(minted.body.key.workspaceIds).toEqual([w1])
      const key = bearer(minted.body.secret)

      const implied = await app.call<Me>('GET', '/api/v1/me', undefined, key)
      expect(implied.status).toBe(200)
      expect(implied.body.workspaceId).toBe(w1)

      const elsewhere = await app.call<Refusal>('GET', '/api/v1/me', undefined, {
        ...key,
        [WORKSPACE_HEADER]: w2,
      })
      expect(elsewhere.status).toBe(404)
    })

    it('never lets a key mint or revoke past its own reach', async () => {
      const app = harness.makeApp()
      const { w1, w2, adminAuth } = await scenario(app)
      const wide = await mint(app, w1, adminAuth, { scope: 'admin', workspaceIds: null })
      const narrow = await mint(app, w1, adminAuth, { scope: 'admin' })
      const narrowKey = bearer(narrow.body.secret)

      for (const workspaceIds of [null, [w1, w2]]) {
        const refused = await app.call<Refusal>(
          'POST',
          '/api/v1/keys',
          { label: 'too wide', workspaceIds },
          narrowKey,
        )
        expect(refused.status).toBe(403)
        expect(refused.body.error.details?.reason).toBe('workspace_reach_exceeded')
      }
      const revokeWide = await app.call<Refusal>(
        'DELETE',
        `/api/v1/keys/${wide.body.key.id}`,
        undefined,
        narrowKey,
      )
      expect(revokeWide.status).toBe(403)

      // The account-wide key may hand out any subset, named per request.
      const child = await app.call<Minted>(
        'POST',
        '/api/v1/keys',
        { label: 'child', workspaceIds: [w2] },
        { ...bearer(wide.body.secret), [WORKSPACE_HEADER]: w1 },
      )
      expect(child.status).toBe(201)
      expect(child.body.key.workspaceIds).toEqual([w2])
    })

    it('takes an account admin to mint a key wider than the board it is minted from', async () => {
      const app = harness.makeApp()
      const { w1, w2, member } = await scenario(app)
      // A workspace admin holds `secrets.manage` on W1 and nothing on the account.
      await app.workspaceMemberRepository().upsert({
        workspaceId: w1,
        userId: member,
        role: 'admin',
        createdAt: 1,
        addedByUserId: null,
      })
      const memberAuth = bearer(await app.session({ id: member }))

      expect((await mint(app, w1, memberAuth, { scope: 'read' })).status).toBe(201)
      const wider = await mint(app, w1, memberAuth, { scope: 'read', workspaceIds: [w1, w2] })
      expect(wider.status).toBe(403)
      expect(wider.body.error.details?.reason).toBe('account_admin_required')
    })

    it('lists every key that reaches a board, and drops a deleted board from a key', async () => {
      const app = harness.makeApp()
      const { w1, w2, adminAuth } = await scenario(app)
      const wide = await mint(app, w1, adminAuth, { scope: 'read', workspaceIds: null })
      const onlyW2 = await mint(app, w1, adminAuth, { scope: 'read', workspaceIds: [w2] })

      const listed = await app.call<{ keys: { id: string; workspaceId: string }[] }>(
        'GET',
        `/workspaces/${w2}/public-api-keys`,
        undefined,
        adminAuth,
      )
      expect(listed.status).toBe(200)
      expect(listed.body.keys.map((k) => k.id).sort()).toEqual(
        [wide.body.key.id, onlyW2.body.key.id].sort(),
      )
      expect(listed.body.keys.every((k) => k.workspaceId === w2)).toBe(true)

      const deleted = await app.call('DELETE', `/workspaces/${w2}`, undefined, adminAuth)
      expect(deleted.status).toBeLessThan(300)
      // Its only board is gone, so the restricted key reaches nothing and stops authenticating.
      const orphan = await app.call('GET', '/api/v1/me', undefined, bearer(onlyW2.body.secret))
      expect(orphan.status).toBe(401)
      const survivor = await app.call('GET', '/api/v1/me', undefined, {
        ...bearer(wide.body.secret),
        [WORKSPACE_HEADER]: w1,
      })
      expect(survivor.status).toBe(200)
    })
  })
}

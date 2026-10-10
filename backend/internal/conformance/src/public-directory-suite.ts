import type { DirectoryChangePage, DirectoryUser, DirectoryWorkspace } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from './harness.js'

// Cross-runtime conformance for the public DIRECTORY surface (`/api/v1/directory/*`, directory
// sync slice 3), driven over HTTP with real keys so the controller, `DirectoryService` and each
// facade's `DirectoryRepository` are exercised together. The repository's own SQL is pinned by
// `defineDirectoryFeedSuite`; what belongs here is what only the assembled surface can get wrong:
// the snapshot watermark carried across pages, a feed that serves the CURRENT state (or `null`)
// for each change, the key's reach applied as a filter, and the refusals a sync client keys off.
//
// Runs auth-ENABLED, beside the key-reach suite, because an account-wide key takes an account
// admin's session to mint.

interface Page<T> {
  items: T[]
  nextCursor: string | null
  asOfSeq: number
}
interface Refusal {
  error: { code: string; details?: { reason?: string } }
}

export function definePublicDirectorySuite(harness: ConformanceHarness): void {
  describe(`[${harness.name}] public directory surface`, () => {
    let seq = 0
    const uniq = () => {
      seq += 1
      return `${harness.name}-dir-${seq}-${Math.floor(Math.random() * 1e9)}`
    }
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

    /** An org (admin plus one member), two boards, an account-wide key and a W1-only key. */
    async function scenario(app: ConformanceApp) {
      const tag = uniq()
      const { accountId, ownerUserId: admin } = await app.onboarding().makeOrgOwner(`dir-${tag}`)
      const member = (
        await app.onboarding().users.findOrCreateByIdentity('github', `dir-member-${tag}`, {
          name: 'Member',
          email: `dir-member-${tag}@example.com`,
        })
      ).id
      await app.onboarding().addAccountMember(accountId, admin, member, ['developer'])
      const w1 = (await app.createWorkspaceInAccount(accountId, admin, { name: `W1 ${tag}` }))
        .workspace.id
      const w2 = (await app.createWorkspaceInAccount(accountId, admin, { name: `W2 ${tag}` }))
        .workspace.id
      const adminAuth = bearer(await app.session({ id: admin }))
      const mint = async (workspaceIds: string[] | null) => {
        const created = await app.call<{ secret: string }>(
          'POST',
          `/workspaces/${w1}/public-api-keys`,
          { label: 'directory', scope: 'read', workspaceIds },
          adminAuth,
        )
        expect(created.status).toBe(201)
        return bearer(created.body.secret)
      }
      return {
        admin,
        member,
        w1,
        w2,
        adminAuth,
        accountKey: await mint(null),
        w1Key: await mint([w1]),
      }
    }

    it('pages a snapshot under one watermark, and reads the users of the account', async () => {
      const app = harness.makeApp()
      const { admin, member, w1, w2, accountKey } = await scenario(app)

      const first = await app.call<Page<DirectoryWorkspace>>(
        'GET',
        '/api/v1/directory/workspaces?limit=1',
        undefined,
        accountKey,
      )
      expect(first.status).toBe(200)
      expect(first.body.items).toHaveLength(1)
      expect(first.body.nextCursor).not.toBeNull()
      const second = await app.call<Page<DirectoryWorkspace>>(
        'GET',
        `/api/v1/directory/workspaces?limit=1&cursor=${first.body.nextCursor}`,
        undefined,
        accountKey,
      )
      expect(second.body.asOfSeq).toBe(first.body.asOfSeq)
      expect([...first.body.items, ...second.body.items].map((w) => w.id).sort()).toEqual(
        [w1, w2].sort(),
      )

      const users = await app.call<Page<DirectoryUser>>(
        'GET',
        '/api/v1/directory/users',
        undefined,
        accountKey,
      )
      expect(users.status).toBe(200)
      expect(users.body.items.map((u) => u.id).sort()).toEqual([admin, member].sort())
      expect(users.body.nextCursor).toBeNull()
    })

    it('serves each change with the current state, and null once the entity is gone', async () => {
      const app = harness.makeApp()
      const { w1, w2, adminAuth, accountKey } = await scenario(app)
      const snapshot = await app.call<Page<DirectoryWorkspace>>(
        'GET',
        '/api/v1/directory/workspaces',
        undefined,
        accountKey,
      )
      const from = snapshot.body.asOfSeq

      await app.workspaceRepository().rename(w1, 'Renamed board')
      expect(
        (await app.call('DELETE', `/workspaces/${w2}`, undefined, adminAuth)).status,
      ).toBeLessThan(300)

      const page = await app.call<DirectoryChangePage>(
        'GET',
        `/api/v1/directory/changes?after=${from}`,
        undefined,
        accountKey,
      )
      expect(page.status).toBe(200)
      expect(page.body.nextAfter).toBe(page.body.headSeq)
      const renamed = page.body.changes.find(
        (c) => c.entityType === 'workspace' && c.entityId === w1,
      )
      expect(renamed?.entity).toMatchObject({ id: w1, name: 'Renamed board' })
      const deleted = page.body.changes.filter((c) => c.workspaceId === w2)
      expect(deleted.length).toBeGreaterThan(0)
      expect(deleted.every((c) => c.entity === null)).toBe(true)

      // Caught up: the next call from `nextAfter` is empty and stays put.
      const caughtUp = await app.call<DirectoryChangePage>(
        'GET',
        `/api/v1/directory/changes?after=${page.body.nextAfter}`,
        undefined,
        accountKey,
      )
      expect(caughtUp.body.changes).toEqual([])
      expect(caughtUp.body.nextAfter).toBe(page.body.nextAfter)
    })

    it('filters a restricted key to its workspaces and refuses it the account-wide entities', async () => {
      const app = harness.makeApp()
      const { w1, w1Key } = await scenario(app)

      const workspaces = await app.call<Page<DirectoryWorkspace>>(
        'GET',
        '/api/v1/directory/workspaces',
        undefined,
        w1Key,
      )
      expect(workspaces.body.items.map((w) => w.id)).toEqual([w1])

      for (const path of ['/api/v1/directory/users', '/api/v1/directory/account-memberships']) {
        const refused = await app.call<Refusal>('GET', path, undefined, w1Key)
        expect(refused.status).toBe(403)
        expect(refused.body.error.details?.reason).toBe('account_scope_required')
      }

      const changes = await app.call<DirectoryChangePage>(
        'GET',
        '/api/v1/directory/changes',
        undefined,
        w1Key,
      )
      expect(changes.status).toBe(200)
      expect(changes.body.changes.length).toBeGreaterThan(0)
      expect(changes.body.changes.every((c) => c.workspaceId === w1)).toBe(true)
    })

    it('refuses a feed cursor ahead of the feed and a snapshot cursor it never issued', async () => {
      const app = harness.makeApp()
      const { accountKey } = await scenario(app)
      const ahead = await app.call<Refusal>(
        'GET',
        '/api/v1/directory/changes?after=999999999',
        undefined,
        accountKey,
      )
      expect(ahead.status).toBe(409)
      expect(ahead.body.error.details?.reason).toBe('cursor_expired')

      const forged = await app.call<Refusal>(
        'GET',
        '/api/v1/directory/repos?cursor=not-a-cursor',
        undefined,
        accountKey,
      )
      expect(forged.status).toBe(422)
      expect(forged.body.error.details?.reason).toBe('invalid_cursor')
    })
  })
}

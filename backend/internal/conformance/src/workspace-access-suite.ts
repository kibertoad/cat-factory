import type { WorkspaceMemberRecord } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from './harness.js'

// Cross-runtime parity for the workspace-RBAC persistence (workspace-rbac initiative,
// slice 2): the `workspace_members` roster + the `workspaces.access_mode` column. The
// membership tier is runtime-neutral domain behaviour, but each facade persists it in its
// own store (D1 on Cloudflare, Postgres via Drizzle on Node). This suite drives the SAME
// repository assertions — the roster CRUD, the batched `getRolesForUserInWorkspaces`, the
// `removeByAccountMembership` cascade, and the `accessRowOf` / `setAccessMode` access-mode
// round-trip — through whichever real store a runtime hands it, so a column mapped
// differently or a filter built differently fails a test instead of shipping.
//
// The `workspace_members` FKs (→ workspaces, → users) mean this can't use synthetic ids like
// the settings/token suites: it creates REAL org workspaces + users through the facade's
// services first, then exercises the repositories over those rows.

export function defineWorkspaceAccessSuite(harness: ConformanceHarness): void {
  const { name } = harness

  describe(`[${name}] workspace access persistence parity`, () => {
    let seq = 0
    const uniq = () => {
      seq += 1
      return `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    // A fresh real user (satisfies workspace_members.user_id → users).
    async function makeUser(app: ReturnType<ConformanceHarness['makeApp']>, tag: string) {
      const subject = `wa-user-${tag}`
      const user = await app.onboarding().users.findOrCreateByIdentity('github', subject, {
        name: `WA ${tag}`,
        email: `${subject}@example.com`,
      })
      return user.id
    }

    function member(overrides: Partial<WorkspaceMemberRecord>): WorkspaceMemberRecord {
      return {
        workspaceId: 'ws',
        userId: 'usr',
        role: 'member',
        createdAt: 1,
        addedByUserId: null,
        ...overrides,
      }
    }

    it('defaults a fresh board to access mode `account` and flips it via setAccessMode', async () => {
      const app = harness.makeApp()
      const snap = await app.createOrgWorkspace({ name: `WA board ${uniq()}` })
      const wsId = snap.workspace.id
      const repo = app.workspaceRepository()

      const before = await repo.accessRowOf(wsId)
      expect(before).toMatchObject({ accessMode: 'account', accountId: snap.workspace.accountId })

      await repo.setAccessMode(wsId, 'restricted')
      expect((await repo.accessRowOf(wsId))?.accessMode).toBe('restricted')

      await repo.setAccessMode(wsId, 'account')
      expect((await repo.accessRowOf(wsId))?.accessMode).toBe('account')

      // A missing board resolves to undefined (not a thrown / empty row).
      expect(await repo.accessRowOf(`missing-${uniq()}`)).toBeUndefined()
    })

    it('round-trips a member through upsert → get, and upsert updates the role in place', async () => {
      const app = harness.makeApp()
      const tag = uniq()
      const snap = await app.createOrgWorkspace({ name: `WA board ${tag}` })
      const wsId = snap.workspace.id
      const userId = await makeUser(app, tag)
      const grantor = await makeUser(app, `${tag}-by`)
      const repo = app.workspaceMemberRepository()

      expect(await repo.get(wsId, userId)).toBeNull()

      await repo.upsert(
        member({
          workspaceId: wsId,
          userId,
          role: 'viewer',
          addedByUserId: grantor,
          createdAt: 10,
        }),
      )
      expect(await repo.get(wsId, userId)).toMatchObject({
        workspaceId: wsId,
        userId,
        role: 'viewer',
        addedByUserId: grantor,
        createdAt: 10,
      })

      // Upsert on the same PK updates the role (createdAt is not rewritten).
      await repo.upsert(member({ workspaceId: wsId, userId, role: 'admin', createdAt: 999 }))
      const updated = await repo.get(wsId, userId)
      expect(updated?.role).toBe('admin')
      expect(updated?.createdAt).toBe(10)

      await repo.remove(wsId, userId)
      expect(await repo.get(wsId, userId)).toBeNull()
    })

    it('lists a board roster and every board a user belongs to', async () => {
      const app = harness.makeApp()
      const tag = uniq()
      const snap = await app.createOrgWorkspace({ name: `WA board ${tag}` })
      const other = await app.createOrgWorkspace({ name: `WA board2 ${tag}` })
      const wsId = snap.workspace.id
      const otherId = other.workspace.id
      const u1 = await makeUser(app, `${tag}-1`)
      const u2 = await makeUser(app, `${tag}-2`)
      const repo = app.workspaceMemberRepository()

      await repo.upsert(member({ workspaceId: wsId, userId: u1, role: 'admin', createdAt: 1 }))
      await repo.upsert(member({ workspaceId: wsId, userId: u2, role: 'member', createdAt: 2 }))
      await repo.upsert(member({ workspaceId: otherId, userId: u1, role: 'viewer', createdAt: 3 }))

      const roster = await repo.listByWorkspace(wsId)
      expect(roster.map((r) => r.userId).sort()).toEqual([u1, u2].sort())

      const forU1 = await repo.listWorkspaceIdsForUser(u1)
      expect(forU1.sort()).toEqual([wsId, otherId].sort())
      expect(await repo.listWorkspaceIdsForUser(u2)).toEqual([wsId])
    })

    it('annotates a workspace list with the caller role in ONE batch read', async () => {
      const app = harness.makeApp()
      const tag = uniq()
      const a = await app.createOrgWorkspace({ name: `WA a ${tag}` })
      const b = await app.createOrgWorkspace({ name: `WA b ${tag}` })
      const c = await app.createOrgWorkspace({ name: `WA c ${tag}` })
      const userId = await makeUser(app, tag)
      const repo = app.workspaceMemberRepository()

      await repo.upsert(member({ workspaceId: a.workspace.id, userId, role: 'admin' }))
      await repo.upsert(member({ workspaceId: b.workspace.id, userId, role: 'viewer' }))

      const roles = await repo.getRolesForUserInWorkspaces(userId, [
        a.workspace.id,
        b.workspace.id,
        c.workspace.id,
      ])
      expect(roles.get(a.workspace.id)).toBe('admin')
      expect(roles.get(b.workspace.id)).toBe('viewer')
      // No row for board c ⇒ simply absent from the map.
      expect(roles.has(c.workspace.id)).toBe(false)
      // Empty input ⇒ empty map, no query.
      expect((await repo.getRolesForUserInWorkspaces(userId, [])).size).toBe(0)
    })

    it('removeByAccountMembership drops only the boards owned by the given account', async () => {
      const app = harness.makeApp()
      const tag = uniq()
      // Two boards in DIFFERENT accounts (each createOrgWorkspace mints a fresh org).
      const inAcct = await app.createOrgWorkspace({ name: `WA acct ${tag}` })
      const elsewhere = await app.createOrgWorkspace({ name: `WA else ${tag}` })
      const userId = await makeUser(app, tag)
      const repo = app.workspaceMemberRepository()

      await repo.upsert(member({ workspaceId: inAcct.workspace.id, userId, role: 'member' }))
      await repo.upsert(member({ workspaceId: elsewhere.workspace.id, userId, role: 'member' }))

      const accountId = inAcct.workspace.accountId
      expect(accountId).toBeTruthy()
      const removed = await repo.removeByAccountMembership(accountId as string, userId)
      expect(removed).toBe(1)

      // The row in the target account is gone; the one in the other account survives.
      expect(await repo.get(inAcct.workspace.id, userId)).toBeNull()
      expect(await repo.get(elsewhere.workspace.id, userId)).not.toBeNull()
    })
  })
}

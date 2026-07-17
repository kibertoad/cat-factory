import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from './harness.js'

// Cross-runtime parity for workspace-RBAC ENFORCEMENT over the real HTTP gate (workspace-rbac
// initiative, slice 3). Where `defineWorkspaceAccessSuite` asserts the persistence, this asserts
// the resolution + the viewer write floor + list filtering that the shared `mountAuthGate` runs
// on every facade. It MUST run auth-ENABLED: a dev-open harness resolves no access object and
// allows everything, so an RBAC assertion would pass vacuously — the suite gates on
// `app.authEnabled` and drives requests as real signed sessions.
//
// The FKs (`workspace_members` → workspaces/users, memberships → accounts/users) mean it seeds
// REAL orgs + users + boards through the facade's services, then drives HTTP `call`s as each user.

interface Row {
  id: string
}
interface SnapshotBody {
  access?: { role: string; permissions: string[] }
}

export function defineWorkspaceRbacSuite(harness: ConformanceHarness): void {
  const { name } = harness

  describe(`[${name}] workspace RBAC enforcement (HTTP)`, () => {
    let seq = 0
    const uniq = () => {
      seq += 1
      return `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    /**
     * Seed one org (admin A), two account members (B, C), and a board W owned by NOBODY so no
     * creator auto-enroll row exists — leaving A an account admin with no explicit member row
     * (the escape-hatch scenario). W starts in the default `account` mode.
     */
    async function scenario(app: ConformanceApp) {
      const tag = uniq()
      const { accountId, ownerUserId: adminA } = await app.onboarding().makeOrgOwner(`rbac-${tag}`)
      const mkUser = async (who: string) =>
        (
          await app.onboarding().users.findOrCreateByIdentity('github', `rbac-${who}-${tag}`, {
            name: who.toUpperCase(),
            email: `rbac-${who}-${tag}@example.com`,
          })
        ).id
      const b = await mkUser('b')
      const c = await mkUser('c')
      await app.onboarding().addAccountMember(accountId, adminA, b, ['developer'])
      await app.onboarding().addAccountMember(accountId, adminA, c, ['developer'])
      const w = await app.createWorkspaceInAccount(accountId, null, { name: `W ${tag}` })
      return { accountId, adminA, b, c, wsId: w.workspace.id }
    }

    const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

    // This first assertion is the suite-wide guard: every harness that wires this suite MUST run
    // auth-enabled, so the cases below don't need (and deliberately omit) a per-test
    // `if (!app.authEnabled) return` — that would let a genuine mis-wiring pass VACUOUSLY, the very
    // thing the suite exists to prevent. A harness with no session secret (e.g. mothership) simply
    // never wires this suite; if one ever did, this test fails loudly instead of the rest no-oping.
    it('runs auth-enabled (RBAC assertions are meaningful, not vacuous)', () => {
      // Every facade harness MUST configure a session secret so the gate actually enforces.
      expect(harness.makeApp().authEnabled).toBe(true)
    })

    it('restricted board: a non-member gets 404 and it is absent from their list; the account admin keeps full access (escape hatch)', async () => {
      const app = harness.makeApp()
      const { adminA, c, wsId } = await scenario(app)
      await app.workspaceRepository().setAccessMode(wsId, 'restricted')

      const tokenC = await app.session({ id: c })
      const snapC = await app.call<unknown>('GET', `/workspaces/${wsId}`, undefined, bearer(tokenC))
      expect(snapC.status).toBe(404) // existence is not leaked
      const listC = await app.call<Row[]>('GET', '/workspaces', undefined, bearer(tokenC))
      expect(listC.status).toBe(200)
      expect(listC.body.some((w) => w.id === wsId)).toBe(false)

      const tokenA = await app.session({ id: adminA })
      const snapA = await app.call<SnapshotBody>(
        'GET',
        `/workspaces/${wsId}`,
        undefined,
        bearer(tokenA),
      )
      expect(snapA.status).toBe(200)
      expect(snapA.body.access?.role).toBe('admin')
      const listA = await app.call<Row[]>('GET', '/workspaces', undefined, bearer(tokenA))
      expect(listA.body.some((w) => w.id === wsId)).toBe(true)
    })

    it('viewer write floor: a viewer reads but cannot write; the ticket mint is allowlisted; a member passes the floor', async () => {
      const app = harness.makeApp()
      const { adminA, b, wsId } = await scenario(app)
      await app.workspaceRepository().setAccessMode(wsId, 'restricted')
      await app.workspaceMemberRepository().upsert({
        workspaceId: wsId,
        userId: b,
        role: 'viewer',
        createdAt: 1,
        addedByUserId: adminA,
      })
      const h = bearer(await app.session({ id: b }))

      const snap = await app.call<SnapshotBody>('GET', `/workspaces/${wsId}`, undefined, h)
      expect(snap.status).toBe(200)
      expect(snap.body.access?.role).toBe('viewer')

      // Any state-changing method is refused wholesale (403), even a board rename.
      const patch = await app.call('PATCH', `/workspaces/${wsId}`, { name: 'nope' }, h)
      expect(patch.status).toBe(403)

      // The read-only stream ticket mint is the one allowlisted write.
      const ticket = await app.call('POST', `/workspaces/${wsId}/events/ticket`, {}, h)
      expect(ticket.status).toBe(200)

      // Upgrade B to member (resolution reads live — no cache until a later slice) ⇒ writes pass.
      await app.workspaceMemberRepository().upsert({
        workspaceId: wsId,
        userId: b,
        role: 'member',
        createdAt: 1,
        addedByUserId: adminA,
      })
      const patch2 = await app.call('PATCH', `/workspaces/${wsId}`, { name: `ok-${uniq()}` }, h)
      expect(patch2.status).toBe(200)
    })

    it('account mode: every account member sees + reads the board (legacy behaviour, no member row)', async () => {
      const app = harness.makeApp()
      const { c, wsId } = await scenario(app) // W stays in the default `account` mode
      const h = bearer(await app.session({ id: c }))

      const list = await app.call<Row[]>('GET', '/workspaces', undefined, h)
      expect(list.body.some((w) => w.id === wsId)).toBe(true)
      const snap = await app.call<SnapshotBody>('GET', `/workspaces/${wsId}`, undefined, h)
      expect(snap.status).toBe(200)
      expect(snap.body.access?.role).toBe('member')
    })

    it('list annotation: a restricted board reached via an explicit row carries the caller viewerRole', async () => {
      const app = harness.makeApp()
      const { adminA, b, wsId } = await scenario(app)
      await app.workspaceRepository().setAccessMode(wsId, 'restricted')
      await app.workspaceMemberRepository().upsert({
        workspaceId: wsId,
        userId: b,
        role: 'viewer',
        createdAt: 1,
        addedByUserId: adminA,
      })
      const list = await app.call<Array<Row & { viewerRole?: string }>>(
        'GET',
        '/workspaces',
        undefined,
        bearer(await app.session({ id: b })),
      )
      const entry = list.body.find((w) => w.id === wsId)
      expect(entry).toBeTruthy()
      expect(entry?.viewerRole).toBe('viewer')
    })
  })
}

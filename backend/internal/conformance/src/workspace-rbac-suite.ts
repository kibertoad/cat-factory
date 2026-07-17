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
      const { adminA, b, c, wsId } = await scenario(app)
      await app.workspaceRepository().setAccessMode(wsId, 'restricted')
      // B is a viewer, C is a member. Seed both rows before either user is read, so each caller's
      // access resolves fresh on their first request — this test is agnostic to whether the
      // `workspaceAccess` cache is enabled on the facade (a raw-repo roster write does NOT
      // invalidate; the coherence of a LIVE roster change is asserted separately below).
      await app.workspaceMemberRepository().upsert({
        workspaceId: wsId,
        userId: b,
        role: 'viewer',
        createdAt: 1,
        addedByUserId: adminA,
      })
      await app.workspaceMemberRepository().upsert({
        workspaceId: wsId,
        userId: c,
        role: 'member',
        createdAt: 1,
        addedByUserId: adminA,
      })
      const hb = bearer(await app.session({ id: b }))

      const snap = await app.call<SnapshotBody>('GET', `/workspaces/${wsId}`, undefined, hb)
      expect(snap.status).toBe(200)
      expect(snap.body.access?.role).toBe('viewer')

      // Any state-changing method is refused wholesale (403) — a board.write like adding a block.
      const write = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks`,
        { type: 'service', position: { x: 0, y: 0 } },
        hb,
      )
      expect(write.status).toBe(403)

      // The read-only stream ticket mint is the one allowlisted write.
      const ticket = await app.call('POST', `/workspaces/${wsId}/events/ticket`, {}, hb)
      expect(ticket.status).toBe(200)

      // A member (C) passes the floor and may perform a board.write (add a block).
      const hc = bearer(await app.session({ id: c }))
      const write2 = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks`,
        { type: 'service', position: { x: 0, y: 0 } },
        hc,
      )
      expect(write2.status).toBe(201)
    })

    it('cache coherence: granting account membership is visible on the immediately following request', async () => {
      const app = harness.makeApp()
      const tag = uniq()
      const { accountId, ownerUserId: adminA } = await app
        .onboarding()
        .makeOrgOwner(`rbac-coh-${tag}`)
      const outsider = (
        await app.onboarding().users.findOrCreateByIdentity('github', `rbac-out-${tag}`, {
          name: 'OUT',
          email: `rbac-out-${tag}@example.com`,
        })
      ).id
      const w = await app.createWorkspaceInAccount(accountId, null, { name: `W ${tag}` })
      const wsId = w.workspace.id
      const h = bearer(await app.session({ id: outsider }))

      // Not an account member yet ⇒ denied (404). On a caching facade this negative outcome is now
      // cached (group = workspace id, key = user id); on a pass-through facade it's simply re-read.
      const before = await app.call('GET', `/workspaces/${wsId}`, undefined, h)
      expect(before.status).toBe(404)

      // Grant account membership through the REAL service — `AccountService.addMember` fires the
      // `onAccountMembershipChanged` hook the container wires to `workspaceAccess.invalidateAll()`.
      await app.onboarding().addAccountMember(accountId, adminA, outsider, ['developer'])

      // The cached denial must have been dropped: the very next request re-resolves and now sees
      // the board as a member. If invalidation were missing, a caching facade would still 404 here.
      const after = await app.call<SnapshotBody>('GET', `/workspaces/${wsId}`, undefined, h)
      expect(after.status).toBe(200)
      expect(after.body.access?.role).toBe('member')
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

    it('member management over HTTP: restrict, add, re-role and remove with LIVE cache coherence (slice 5)', async () => {
      const app = harness.makeApp()
      const { adminA, b, c, wsId } = await scenario(app)
      const ha = bearer(await app.session({ id: adminA }))

      // Restrict the board through the REAL route — admin A is the account-admin escape hatch, so
      // resolution grants `members.manage` even with no explicit member row. The write must
      // invalidate the access cache group, so the change is visible on the very next request.
      const restrict = await app.call(
        'PUT',
        `/workspaces/${wsId}/access-mode`,
        { accessMode: 'restricted' },
        ha,
      )
      expect(restrict.status).toBe(200)

      // Immediately: account member C (no explicit row) is now denied. If the access-mode flip
      // didn't drop the cache group, a caching facade would still serve the stale `member` grant.
      const hc = bearer(await app.session({ id: c }))
      const cDenied = await app.call('GET', `/workspaces/${wsId}`, undefined, hc)
      expect(cDenied.status).toBe(404)

      // Add B as a viewer over HTTP; visible on the immediately following request.
      const add = await app.call(
        'POST',
        `/workspaces/${wsId}/members`,
        { userId: b, role: 'viewer' },
        ha,
      )
      expect(add.status).toBe(201)
      const hb = bearer(await app.session({ id: b }))
      const bView = await app.call<SnapshotBody>('GET', `/workspaces/${wsId}`, undefined, hb)
      expect(bView.status).toBe(200)
      expect(bView.body.access?.role).toBe('viewer')
      // A viewer still can't write (the method floor).
      expect((await app.call('PATCH', `/workspaces/${wsId}`, { name: 'no' }, hb)).status).toBe(403)

      // The roster read is open to any resolved role and reflects the add.
      const roster = await app.call<Array<{ userId: string; role: string }>>(
        'GET',
        `/workspaces/${wsId}/members`,
        undefined,
        ha,
      )
      expect(roster.body.some((m) => m.userId === b && m.role === 'viewer')).toBe(true)

      // Promote B to member — immediately B may write (cache coherence on the role change).
      const promote = await app.call(
        'PATCH',
        `/workspaces/${wsId}/members/${b}`,
        { role: 'member' },
        ha,
      )
      expect(promote.status).toBe(200)
      const bWrite = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks`,
        { type: 'service', position: { x: 0, y: 0 } },
        hb,
      )
      expect(bWrite.status).toBe(201)

      // Remove B — immediately denied again (the removal dropped the cache group).
      const remove = await app.call('DELETE', `/workspaces/${wsId}/members/${b}`, undefined, ha)
      expect(remove.status).toBe(204)
      const bGone = await app.call('GET', `/workspaces/${wsId}`, undefined, hb)
      expect(bGone.status).toBe(404)
    })

    it('members.manage: a plain member reads the roster but cannot mutate it or the access mode (403)', async () => {
      const app = harness.makeApp()
      const { adminA, b, c, wsId } = await scenario(app)
      const ha = bearer(await app.session({ id: adminA }))
      await app.call('PUT', `/workspaces/${wsId}/access-mode`, { accessMode: 'restricted' }, ha)
      await app.call('POST', `/workspaces/${wsId}/members`, { userId: c, role: 'member' }, ha)
      const hc = bearer(await app.session({ id: c }))

      // A member may read the roster (workspace.read, via resolution).
      expect((await app.call('GET', `/workspaces/${wsId}/members`, undefined, hc)).status).toBe(200)
      // But every roster/access-mode WRITE needs `members.manage` (403 — the caller sees the board,
      // so insufficiency, not existence, is revealed).
      expect(
        (await app.call('POST', `/workspaces/${wsId}/members`, { userId: b, role: 'viewer' }, hc))
          .status,
      ).toBe(403)
      expect(
        (await app.call('PATCH', `/workspaces/${wsId}/members/${c}`, { role: 'admin' }, hc)).status,
      ).toBe(403)
      expect(
        (await app.call('DELETE', `/workspaces/${wsId}/members/${c}`, undefined, hc)).status,
      ).toBe(403)
      expect(
        (await app.call('PUT', `/workspaces/${wsId}/access-mode`, { accessMode: 'account' }, hc))
          .status,
      ).toBe(403)
    })

    it('admin-tier enforcement: a plain member is refused a write on EVERY settings/integrations/secrets controller (403); the admin is not (slice 6)', async () => {
      const app = harness.makeApp()
      const { adminA, c, wsId } = await scenario(app)
      const ha = bearer(await app.session({ id: adminA }))
      // Restrict + scope C as a plain member: full board.write / runs.execute, but none of the
      // admin permissions. Every write below passes the viewer floor (C is a member), so a 403
      // can ONLY come from the admin-tier `requireWorkspacePermission` gate. The controller-level
      // middleware runs BEFORE request-body validation and the handler's 503/lookup, so these
      // writes need no valid body and no configured module — a member is refused whether or not
      // the integration is wired (its config is never revealed). One representative write per
      // admin controller, so a controller that forgot to mount the gate fails HERE, not silently
      // in production (the drift the CLAUDE.md "add a NEW admin controller" note warns about).
      await app.call('PUT', `/workspaces/${wsId}/access-mode`, { accessMode: 'restricted' }, ha)
      await app.call('POST', `/workspaces/${wsId}/members`, { userId: c, role: 'member' }, ha)
      const hc = bearer(await app.session({ id: c }))

      // A representative WRITE per admin controller (path is workspace-relative; the controller is
      // mounted under `/workspaces/:workspaceId`). `body` is set ONLY where the gate is per-handler
      // and thus runs AFTER body validation (WorkspaceController) — those need a valid body so the
      // permission check, not a 422, is what rejects. Controller-level middleware fires at the mount
      // before validation, so those entries carry no body.
      const w = (path: string) => `/workspaces/${wsId}${path}`
      const adminWrites: Array<{
        perm: string
        method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
        path: string
        body?: unknown
      }> = [
        // settings.manage
        { perm: 'settings.manage', method: 'PATCH', path: w(''), body: { name: `no-${uniq()}` } }, // board rename (per-handler)
        { perm: 'settings.manage', method: 'PUT', path: w('/settings') },
        { perm: 'settings.manage', method: 'PUT', path: w('/tracker-settings') },
        { perm: 'settings.manage', method: 'DELETE', path: w('/model-presets/none') },
        { perm: 'settings.manage', method: 'DELETE', path: w('/risk-policies/none') },
        { perm: 'settings.manage', method: 'DELETE', path: w('/observability/connection') },
        { perm: 'settings.manage', method: 'DELETE', path: w('/incident-enrichment') },
        { perm: 'settings.manage', method: 'DELETE', path: w('/prompt-fragments/none') }, // fragment library (workspace scope)
        // integrations.manage
        { perm: 'integrations.manage', method: 'DELETE', path: w('/package-registries/none') },
        {
          perm: 'integrations.manage',
          method: 'DELETE',
          path: w('/bootstrap/reference-architectures/none'),
        },
        { perm: 'integrations.manage', method: 'DELETE', path: w('/github/connection') },
        { perm: 'integrations.manage', method: 'DELETE', path: w('/slack/connection') },
        { perm: 'integrations.manage', method: 'DELETE', path: w('/environments/connection') },
        { perm: 'integrations.manage', method: 'DELETE', path: w('/runner-pool/connection') },
        {
          perm: 'integrations.manage',
          method: 'DELETE',
          path: w('/task-sources/github/connection'),
        },
        {
          perm: 'integrations.manage',
          method: 'DELETE',
          path: w('/document-sources/github/connection'),
        },
        { perm: 'integrations.manage', method: 'DELETE', path: w('/shared-stacks/none') },
        { perm: 'integrations.manage', method: 'DELETE', path: w('/sandbox/prompts/none') },
        { perm: 'integrations.manage', method: 'DELETE', path: w('/frames/none/preview') },
        // secrets.manage
        { perm: 'secrets.manage', method: 'DELETE', path: w('/vendor-credentials/none') },
        { perm: 'secrets.manage', method: 'DELETE', path: w('/api-keys/none') },
        { perm: 'secrets.manage', method: 'DELETE', path: w('/public-api-keys/none') },
        { perm: 'secrets.manage', method: 'DELETE', path: w('/services/none/test-secrets') },
      ]

      // A plain member is refused every one (403). Fold the route into the asserted value so a
      // regression names the exact controller that let the member through.
      for (const req of adminWrites) {
        const res = await app.call(req.method, req.path, req.body, hc)
        expect({ route: `${req.method} ${req.path}`, status: res.status }).toEqual({
          route: `${req.method} ${req.path}`,
          status: 403,
        })
      }

      // The account admin (A) clears every admin gate: the SAME writes resolve PAST the permission
      // check (200/204/404/422/503 by wiring + body), never a 403 — proving each 403 above is the
      // gate rejecting the member, not a route that simply always rejects.
      for (const req of adminWrites) {
        const res = await app.call(req.method, req.path, req.body, ha)
        expect({ route: `${req.method} ${req.path}`, forbidden: res.status === 403 }).toEqual({
          route: `${req.method} ${req.path}`,
          forbidden: false,
        })
      }
    })

    it('only account members can be scoped: adding an outsider is rejected (422)', async () => {
      const app = harness.makeApp()
      const { adminA, wsId } = await scenario(app)
      const ha = bearer(await app.session({ id: adminA }))
      await app.call('PUT', `/workspaces/${wsId}/access-mode`, { accessMode: 'restricted' }, ha)
      const tag = uniq()
      const outsider = (
        await app.onboarding().users.findOrCreateByIdentity('github', `rbac-outsider-${tag}`, {
          name: 'OUTSIDER',
          email: `rbac-outsider-${tag}@example.com`,
        })
      ).id
      const res = await app.call(
        'POST',
        `/workspaces/${wsId}/members`,
        { userId: outsider, role: 'member' },
        ha,
      )
      expect(res.status).toBe(422) // account membership is a prerequisite for a workspace grant
    })

    it('re-adding an existing member preserves the original grant metadata (createdAt/addedBy)', async () => {
      const app = harness.makeApp()
      const { adminA, b, wsId } = await scenario(app)
      const ha = bearer(await app.session({ id: adminA }))
      await app.call('PUT', `/workspaces/${wsId}/access-mode`, { accessMode: 'restricted' }, ha)
      // Seed B's row directly with a KNOWN createdAt + grantor, so a re-add that (incorrectly)
      // re-stamped a fresh clock/actor is caught regardless of the harness clock — the upsert
      // preserves both on conflict (it updates ONLY `role`), so the response must too.
      await app.workspaceMemberRepository().upsert({
        workspaceId: wsId,
        userId: b,
        role: 'viewer',
        createdAt: 4242,
        addedByUserId: adminA,
      })
      const readd = await app.call<{ role: string; createdAt: number; addedBy: string | null }>(
        'POST',
        `/workspaces/${wsId}/members`,
        { userId: b, role: 'member' },
        ha,
      )
      expect(readd.status).toBe(201)
      expect(readd.body.role).toBe('member') // the role DID change (upsert semantics)
      expect(readd.body.createdAt).toBe(4242) // original createdAt preserved, not re-stamped
      expect(readd.body.addedBy).toBe(adminA) // original grantor preserved
      // The persisted roster agrees with the response (no drift between the 201 body and the store).
      const roster = await app.call<Array<{ userId: string; createdAt: number; addedBy: string }>>(
        'GET',
        `/workspaces/${wsId}/members`,
        undefined,
        ha,
      )
      const row = roster.body.find((m) => m.userId === b)!
      expect(row.createdAt).toBe(4242)
      expect(row.addedBy).toBe(adminA)
    })

    it('auto-heal: managing members on a legacy (unscoped) board adopts it into the owner’s account, then proceeds', async () => {
      const app = harness.makeApp()
      const { accountId, b, c } = await scenario(app)
      // A legacy board (account_id IS NULL) owned by B, who belongs to exactly one account (the
      // org). On a legacy board only the OWNER can reach member management (the account-admin
      // escape hatch does not apply to the null-account branch), so B is the operator here.
      const legacyId = `legacy-${uniq()}`
      await app
        .workspaceRepository()
        .create(
          { id: legacyId, name: 'Legacy', description: null, createdAt: 1, accountId: null },
          b,
          null,
        )
      const hb = bearer(await app.session({ id: b }))
      // Restricting it heals it: the board is linked to B's account and the flip takes effect.
      const restrict = await app.call<{ accountId: string | null }>(
        'PUT',
        `/workspaces/${legacyId}/access-mode`,
        { accessMode: 'restricted' },
        hb,
      )
      expect(restrict.status).toBe(200)
      expect(restrict.body.accountId).toBe(accountId)
      // Persisted: the board now belongs to the owner's account (no longer legacy).
      expect((await app.workspaceRepository().accessRowOf(legacyId))?.accountId).toBe(accountId)
      // B keeps admin control after the heal + restrict (the owner admin row was seeded, so a
      // restricted board — which reads member rows only — can't lock its owner out).
      const snap = await app.call<SnapshotBody>('GET', `/workspaces/${legacyId}`, undefined, hb)
      expect(snap.status).toBe(200)
      expect(snap.body.access?.role).toBe('admin')
      // And a fellow account member (C) can now be scoped over HTTP (the board is account-backed).
      const add = await app.call(
        'POST',
        `/workspaces/${legacyId}/members`,
        { userId: c, role: 'viewer' },
        hb,
      )
      expect(add.status).toBe(201)
    })

    it('auto-heal is refused when the owner’s account is ambiguous — link the board explicitly (422)', async () => {
      const app = harness.makeApp()
      const { accountId, adminA } = await scenario(app)
      // A second org, and an owner who belongs to BOTH accounts — so the auto-heal can't pick one.
      const tag = uniq()
      const { accountId: account2, ownerUserId: adminA2 } = await app
        .onboarding()
        .makeOrgOwner(`rbac2-${tag}`)
      const owner = (
        await app.onboarding().users.findOrCreateByIdentity('github', `rbac-multi-${tag}`, {
          name: 'MULTI',
          email: `rbac-multi-${tag}@example.com`,
        })
      ).id
      await app.onboarding().addAccountMember(accountId, adminA, owner, ['developer'])
      await app.onboarding().addAccountMember(account2, adminA2, owner, ['developer'])
      const legacyId = `legacy-${uniq()}`
      await app
        .workspaceRepository()
        .create(
          { id: legacyId, name: 'Legacy2', description: null, createdAt: 1, accountId: null },
          owner,
          null,
        )
      const ho = bearer(await app.session({ id: owner }))
      const res = await app.call(
        'PUT',
        `/workspaces/${legacyId}/access-mode`,
        { accessMode: 'restricted' },
        ho,
      )
      expect(res.status).toBe(422) // ambiguous: no single account to adopt the board into
    })

    it('side door: /me/environment-handlers resolves workspace access — non-member 404, viewer 403, member/admin pass the gate (slice 7)', async () => {
      const app = harness.makeApp()
      const { adminA, b, c, wsId } = await scenario(app)
      await app.workspaceRepository().setAccessMode(wsId, 'restricted')
      // B is a viewer (sees the board, lacks runs.execute); C is NOT a member of the restricted
      // board. Each user's access resolves fresh on first read, so this is cache-agnostic.
      await app.workspaceMemberRepository().upsert({
        workspaceId: wsId,
        userId: b,
        role: 'viewer',
        createdAt: 1,
        addedByUserId: adminA,
      })
      // This route is mounted at `/` (outside the `/workspaces/:ws/*` gate), so it resolves access
      // itself through the shared helper and requires `runs.execute`. Authorization runs BEFORE the
      // local-only service-availability 503, so the verdict is identical on every facade regardless
      // of whether the handler service is wired.
      const path = `/me/environment-handlers/${wsId}`

      // C: not a member ⇒ 404 (existence hidden exactly as the gate hides a board).
      expect(
        (await app.call('GET', path, undefined, bearer(await app.session({ id: c })))).status,
      ).toBe(404)
      // B: a viewer sees the board but lacks runs.execute ⇒ 403 (insufficiency, not existence).
      expect(
        (await app.call('GET', path, undefined, bearer(await app.session({ id: b })))).status,
      ).toBe(403)
      // A: account admin (escape hatch) holds runs.execute ⇒ clears the RBAC gate (never 404/403).
      // The concrete status past the gate depends on whether the facade wired the local-only
      // handler service (200 where wired, 503 where not), so only assert it is NOT a gate refusal.
      const aStatus = (
        await app.call('GET', path, undefined, bearer(await app.session({ id: adminA })))
      ).status
      expect(aStatus).not.toBe(404)
      expect(aStatus).not.toBe(403)
    })

    it('side door: minting a public-API key records the acting user (created_by_user_id parity, slice 7)', async () => {
      const app = harness.makeApp()
      const { adminA, wsId } = await scenario(app) // W is account-backed (public API is account-scoped)
      const ha = bearer(await app.session({ id: adminA }))
      // Admin A holds `secrets.manage` (slice 6 gates the mint), so the key is minted; the acting
      // user is stamped onto `created_by_user_id` and surfaced on the wire.
      const created = await app.call<{ key: { id: string; createdByUserId: string | null } }>(
        'POST',
        `/workspaces/${wsId}/public-api-keys`,
        { label: 'external' },
        ha,
      )
      expect(created.status).toBe(201)
      expect(created.body.key.createdByUserId).toBe(adminA)
      // The minter round-trips through the real store identically on D1 and Postgres.
      const list = await app.call<{ keys: Array<{ id: string; createdByUserId: string | null }> }>(
        'GET',
        `/workspaces/${wsId}/public-api-keys`,
        undefined,
        ha,
      )
      expect(list.body.keys.find((k) => k.id === created.body.key.id)?.createdByUserId).toBe(adminA)
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

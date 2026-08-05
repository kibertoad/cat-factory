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

/**
 * What {@link defineWorkspaceRbacSuite}'s `scenario` helper seeds: one org (admin A), two account
 * members (B, C) and a board W owned by NOBODY, so no creator auto-enroll row exists.
 */
type RbacScenarioSeeder = (
  app: ConformanceApp,
) => Promise<{ accountId: string; adminA: string; b: string; c: string; wsId: string }>

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

    registerRbacMemberManagementTests(harness, scenario, bearer, uniq)
    registerRbacAdminTierTests(harness, scenario, bearer, uniq)
    registerRiskPolicySelectionTests(harness, scenario, bearer)
  })
}

/**
 * Member management over HTTP — restrict, add, re-role, remove — with the live cache
 * coherence each mutation must publish, and the `members.manage` refusal for a plain member.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerRbacMemberManagementTests(
  harness: ConformanceHarness,
  scenario: RbacScenarioSeeder,
  bearer: (token: string) => { authorization: string },
  uniq: () => string,
): void {
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
      // The consensus-GROUP library. Same permission as the model-preset library above and for
      // the same reason: a group decides which models review a task and how many of them run,
      // so editing one changes what every run in the workspace costs and who judges it — the
      // model mapping's blast radius, not a member-tier pipeline edit.
      { perm: 'settings.manage', method: 'DELETE', path: w('/consensus-groups/none') },
      // Agent prompt overrides: the pipeline builder itself is member-tier, but an edited
      // system prompt changes how every run in the workspace behaves — the same blast radius
      // as the model mapping above, so the same permission. (The controller has no DELETE:
      // going back to the built-in is a PUT with a null text.)
      { perm: 'settings.manage', method: 'PUT', path: w('/agent-prompts/coder') },
      // Promoting a sandbox version writes the live agent prompt, so it answers to the prompt
      // permission and NOT to the sandbox controller's `integrations.manage` — otherwise the
      // sandbox would be a way around the gate that guards editing a prompt directly.
      { perm: 'settings.manage', method: 'POST', path: w('/agent-prompts/coder/promote') },
      { perm: 'settings.manage', method: 'DELETE', path: w('/risk-policies/none') },
      { perm: 'settings.manage', method: 'DELETE', path: w('/observability/connection') },
      { perm: 'settings.manage', method: 'DELETE', path: w('/incident-enrichment') },
      { perm: 'settings.manage', method: 'DELETE', path: w('/prompt-fragments/none') }, // fragment library (workspace scope)
      // Pre-PR validation checks are operator-authored SHELL COMMANDS that run in the run's
      // container, so the write is admin-tier even though the values are not secrets.
      { perm: 'settings.manage', method: 'DELETE', path: w('/services/none/validation-checks') },
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
      { perm: 'secrets.manage', method: 'DELETE', path: w('/capability-credentials/none') },
      // The tool-server PROBE. Gated for two reasons, either of which would be enough: the result
      // names the deployment's credential keys, and the request itself SPENDS an outbound call
      // against a third party under the deployment's own credential.
      { perm: 'secrets.manage', method: 'POST', path: w('/tool-servers/none/test') },
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

  it('document sources are TIER-SPLIT: a member imports, attaches and spawns; only an admin connects', async () => {
    // The one controller that deliberately splits by TIER, so neither half is provable from the
    // table above: that one asserts a member is refused a representative write per ADMIN
    // controller, and here the same member must be ALLOWED five writes on the same controller.
    //
    // Attaching context to a task is board authoring (the Add-task picker imports the pasted ref
    // and links it), so holding the whole controller at `integrations.manage` locked the feature
    // to operators. What must stay refused is the CREDENTIAL: connect and disconnect.
    const app = harness.makeApp()
    const { adminA, b, c, wsId } = await scenario(app)
    const ha = bearer(await app.session({ id: adminA }))
    await app.call('PUT', `/workspaces/${wsId}/access-mode`, { accessMode: 'restricted' }, ha)
    await app.call('POST', `/workspaces/${wsId}/members`, { userId: c, role: 'member' }, ha)
    await app.call('POST', `/workspaces/${wsId}/members`, { userId: b, role: 'viewer' }, ha)
    const hc = bearer(await app.session({ id: c }))
    const hb = bearer(await app.session({ id: b }))
    const w = (path: string) => `/workspaces/${wsId}${path}`

    // The member-tier writes. Asserted as "not 403" rather than as a success status because what
    // is under test is the GATE, not the integration: past it these resolve on wiring and payload
    // (503 with no documents module, 404 for a ref this workspace never imported), and pinning a
    // concrete status here would make the assertion a test of the harness's own wiring.
    const authoring: Array<{ method: 'POST'; path: string; body: unknown }> = [
      { method: 'POST', path: w('/document-sources/notion/import'), body: { ref: 'nope' } },
      { method: 'POST', path: w('/document-sources/notion/search'), body: { query: 'spec' } },
      { method: 'POST', path: w('/document-sources/notion/plan'), body: { externalId: 'nope' } },
      { method: 'POST', path: w('/document-sources/notion/spawn'), body: { externalId: 'nope' } },
      {
        method: 'POST',
        path: w('/documents/link'),
        body: { source: 'notion', externalId: 'nope', blockId: 'nope' },
      },
    ]
    for (const req of authoring) {
      const res = await app.call(req.method, req.path, req.body, hc)
      expect({ route: `${req.method} ${req.path}`, forbidden: res.status === 403 }).toEqual({
        route: `${req.method} ${req.path}`,
        forbidden: false,
      })
      // A VIEWER is still refused every one of them, by the gate's method-shaped write floor. This
      // is what keeps the change a tier MOVE rather than an opening: without it, "not 403 for a
      // member" would also pass if the gate had been dropped altogether.
      const denied = await app.call(req.method, req.path, req.body, hb)
      expect({ route: `${req.method} ${req.path}`, status: denied.status }).toEqual({
        route: `${req.method} ${req.path}`,
        status: 403,
      })
    }

    // The credential half stays admin-only. Connect carries a VALID body, because the mount gates
    // this path specifically and a malformed payload would be refused by validation instead, which
    // would pass this assertion for the wrong reason.
    const connect = w('/document-sources/notion/connect')
    expect((await app.call('POST', connect, { credentials: { token: 't' } }, hc)).status).toBe(403)
    expect(
      (await app.call('DELETE', w('/document-sources/notion/connection'), undefined, hc)).status,
    ).toBe(403)
    // And the admin still clears both (never a 403), so the refusals above are the gate rejecting
    // the member rather than routes that always reject.
    expect((await app.call('POST', connect, { credentials: { token: 't' } }, ha)).status).not.toBe(
      403,
    )
    expect(
      (await app.call('DELETE', w('/document-sources/notion/connection'), undefined, ha)).status,
    ).not.toBe(403)
  })

  it('admin-tier enforcement: the branch-protection preflight is a gated READ, unlike every other GitHub read (slice 6)', async () => {
    // Its own test rather than a row in the table above, because it breaks that table's premise:
    // those are WRITES, which `requireWorkspacePermission` gates wholesale. A GET passes the
    // mounted gate untouched by design — reads are presumed cheap and safe — so this route
    // gates itself imperatively, and only an explicit assertion can catch that call being lost
    // in a later refactor. The reason it must be gated is that this read is neither cheap nor
    // safe: it spends the installation's GitHub rate limit, a budget the CI gate and the merger
    // draw on for every run, so on the read tier any viewer could degrade the write path.
    const app = harness.makeApp()
    const { adminA, c, wsId } = await scenario(app)
    const ha = bearer(await app.session({ id: adminA }))
    await app.call('PUT', `/workspaces/${wsId}/access-mode`, { accessMode: 'restricted' }, ha)
    await app.call('POST', `/workspaces/${wsId}/members`, { userId: c, role: 'member' }, ha)
    const hc = bearer(await app.session({ id: c }))
    const path = `/workspaces/${wsId}/github/branch-protection`

    // A plain member holds `workspace.read` and passes the viewer floor, so a 403 here can only
    // be the per-handler permission check.
    expect((await app.call('GET', path, undefined, hc)).status).toBe(403)

    // A plain GitHub read on the SAME controller stays open to that member — proving the 403
    // above is this route's own gate and not the controller having become admin-only. Asserted
    // as "not forbidden" rather than 200 because the harness wires no GitHub App, so the read
    // resolves past the gate and then 503s on the missing module; what matters is which of the
    // two answered.
    expect(
      (await app.call('GET', `/workspaces/${wsId}/github/repos`, undefined, hc)).status,
    ).not.toBe(403)

    // The admin clears the gate on the preflight itself (200 wired / 503 unwired — never 403).
    expect((await app.call('GET', path, undefined, ha)).status).not.toBe(403)
  })

  it('admin-tier enforcement: the capability-credential and tool-server READS are gated too (MCP maturation slice 4)', async () => {
    // The other exception to the table's premise, and the opposite shape from the preflight above:
    // these two controllers mount `requireWorkspacePermissionIncludingReads`, so the whole
    // controller answers to `secrets.manage` rather than one handler gating itself.
    //
    // They must, because on these two the READ is the sensitive half. Both project the credential
    // KEY NAMES this deployment's capabilities want — which is precisely what the workspace
    // snapshot withholds from a viewer — and the tool-server inventory adds the endpoints those
    // credentials are sent to. Asserted explicitly because the ordinary mount passes GET through by
    // design: for a release both surfaces DOCUMENTED a gated read (in the controller, in the SPA's
    // tab gate, in the store's 403 branch) while every member's GET was answered in full, and
    // nothing failed.
    const app = harness.makeApp()
    const { adminA, c, wsId } = await scenario(app)
    const ha = bearer(await app.session({ id: adminA }))
    await app.call('PUT', `/workspaces/${wsId}/access-mode`, { accessMode: 'restricted' }, ha)
    await app.call('POST', `/workspaces/${wsId}/members`, { userId: c, role: 'member' }, ha)
    const hc = bearer(await app.session({ id: c }))
    const reads = [`/workspaces/${wsId}/capability-credentials`, `/workspaces/${wsId}/tool-servers`]

    for (const path of reads) {
      // A plain member holds `workspace.read` and clears the viewer floor (a GET), so a 403 here is
      // the controller gate and nothing else.
      expect({ path, status: (await app.call('GET', path, undefined, hc)).status }).toEqual({
        path,
        status: 403,
      })
      // The admin resolves PAST the gate: 200 where the module is wired, 503 where it is not, never
      // a 403 — which is what proves the refusal above is the gate rejecting the member rather than
      // a route that always rejects.
      expect({
        path,
        forbidden: (await app.call('GET', path, undefined, ha)).status === 403,
      }).toEqual({ path, forbidden: false })
    }
  })
}

/**
 * Account-membership scoping, the auto-heal that adopts a legacy unscoped board (and its
 * ambiguity refusal), and the two side doors that must resolve workspace access the same way.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerRbacAdminTierTests(
  harness: ConformanceHarness,
  scenario: RbacScenarioSeeder,
  bearer: (token: string) => { authorization: string },
  uniq: () => string,
): void {
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
}

/**
 * The other half of the sandboxed-run mode (ADR 0037), END TO END on both runtimes.
 *
 * Editing `dryRunRoles` is admin-tier, which is why the ADR concluded a sandboxed member cannot
 * un-sandbox themselves. Selecting which preset a TASK is governed by is not: it is a plain
 * `riskPolicyId` on the block patch, at member tier, on the same board. So the sandbox held only
 * as long as nobody re-pointed the task, and one PATCH (or one click in the inspector's picker)
 * was the way around it.
 *
 * These drive real presets, a real board write and the real auth gate, because that is the only
 * place the three meet: a unit test of the rule passes whether or not a door consults it, and a
 * unit test of the door passes whether or not the facade wired the preset repository to it.
 */
function registerRiskPolicySelectionTests(
  harness: ConformanceHarness,
  scenario: RbacScenarioSeeder,
  bearer: (token: string) => { authorization: string },
): void {
  interface Refusal {
    error?: { details?: { reason?: string } }
  }

  /**
   * Seed a RESTRICTING default preset plus an open one, and a task governed by the default.
   *
   * `restriction` is the role-scoped half under test, so each arm of the selection guard is driven
   * through the same real HTTP path: the preset is written and read back by the facade's own
   * repository, which is what makes this a cross-runtime assertion rather than a second unit test.
   */
  async function seedPolicySwap(
    app: ConformanceApp,
    restriction: Record<string, unknown> = { dryRunRoles: ['member'] },
  ) {
    const { adminA, c, wsId } = await scenario(app) // `account` mode: C resolves as a member
    const ha = bearer(await app.session({ id: adminA }))
    const preset = async (name: string, over: Record<string, unknown>) =>
      (
        await app.call<Row>(
          'POST',
          `/workspaces/${wsId}/risk-policies`,
          {
            name,
            maxComplexity: 0.5,
            maxRisk: 0.4,
            maxImpact: 0.5,
            ciMaxAttempts: 10,
            maxRequirementIterations: 6,
            maxRequirementConcernAllowed: 'none',
            ...over,
          },
          ha,
        )
      ).body.id
    const sandboxed = await preset('Restricted', { ...restriction, isDefault: true })
    const open = await preset('Open', {})
    const frame = await app.call<Row>(
      'POST',
      `/workspaces/${wsId}/blocks`,
      { type: 'service', position: { x: 0, y: 0 } },
      ha,
    )
    const task = await app.call<Row>(
      'POST',
      `/workspaces/${wsId}/blocks/${frame.body.id}/tasks`,
      { title: 'Ship it', riskPolicyId: sandboxed },
      ha,
    )
    return { wsId, frameId: frame.body.id, taskId: task.body.id, sandboxed, open, ha, c }
  }

  it('a member cannot re-point a sandboxed task at a preset that does not sandbox them', async () => {
    const app = harness.makeApp()
    const { wsId, taskId, sandboxed, open, ha, c } = await seedPolicySwap(app)
    const hc = bearer(await app.session({ id: c }))

    const swap = await app.call<Refusal>(
      'PATCH',
      `/workspaces/${wsId}/blocks/${taskId}`,
      { riskPolicyId: open },
      hc,
    )
    expect(swap.status).toBe(403)
    expect(swap.body.error?.details?.reason).toBe('relaxes_role_sandbox')

    // Refused BEFORE the write: the task is still governed by the policy that sandboxes them.
    const after = await app.call<{ blocks: Array<{ id: string; riskPolicyId?: string }> }>(
      'GET',
      `/workspaces/${wsId}`,
      undefined,
      ha,
    )
    expect(after.body.blocks.find((b) => b.id === taskId)?.riskPolicyId).toBe(sandboxed)
  })

  it('nor author a NEW task straight onto it, which is the same escape one door along', async () => {
    const app = harness.makeApp()
    const { wsId, frameId, open, c } = await seedPolicySwap(app)
    const hc = bearer(await app.session({ id: c }))
    const created = await app.call<Refusal>(
      'POST',
      `/workspaces/${wsId}/blocks/${frameId}/tasks`,
      { title: 'Fresh start', riskPolicyId: open },
      hc,
    )
    expect(created.status).toBe(403)
    expect(created.body.error?.details?.reason).toBe('relaxes_role_sandbox')
  })

  it('an admin makes the same swap, and the member may still pick a STRICTER policy', async () => {
    // The two halves that keep this a narrowing rule rather than an admin-only picker: whoever
    // owns the preset library is not restrained by a selection, and adopting more review needs
    // no permission at all.
    const app = harness.makeApp()
    const { wsId, taskId, sandboxed, open, ha, c } = await seedPolicySwap(app)
    const hc = bearer(await app.session({ id: c }))

    const byAdmin = await app.call(
      'PATCH',
      `/workspaces/${wsId}/blocks/${taskId}`,
      { riskPolicyId: open },
      ha,
    )
    expect(byAdmin.status).toBe(200)

    const backToSandbox = await app.call(
      'PATCH',
      `/workspaces/${wsId}/blocks/${taskId}`,
      { riskPolicyId: sandboxed },
      hc,
    )
    expect(backToSandbox.status).toBe(200)
  })

  it('nor re-point a task off the submission allowlist their role is held to', async () => {
    // The same escape through ADR 0039's field: an allowlisted role moving to a preset that
    // allowlists them nothing reads as unrestricted, which is the widest policy the setting has.
    const app = harness.makeApp()
    const { wsId, taskId, sandboxed, open, ha, c } = await seedPolicySwap(app, {
      submissionClassesByRole: { member: ['docs'] },
    })
    const hc = bearer(await app.session({ id: c }))

    const swap = await app.call<Refusal>(
      'PATCH',
      `/workspaces/${wsId}/blocks/${taskId}`,
      { riskPolicyId: open },
      hc,
    )
    expect(swap.status).toBe(403)
    expect(swap.body.error?.details?.reason).toBe('relaxes_role_submission_allowlist')

    // Refused BEFORE the write, and an admin makes the same swap.
    const after = await app.call<{ blocks: Array<{ id: string; riskPolicyId?: string }> }>(
      'GET',
      `/workspaces/${wsId}`,
      undefined,
      ha,
    )
    expect(after.body.blocks.find((b) => b.id === taskId)?.riskPolicyId).toBe(sandboxed)
    const byAdmin = await app.call(
      'PATCH',
      `/workspaces/${wsId}/blocks/${taskId}`,
      { riskPolicyId: open },
      ha,
    )
    expect(byAdmin.status).toBe(200)
  })

  it('leaves an ordinary member edit of the same task untouched', async () => {
    // The identity that keeps this additive: the guard is about the preset field, not the patch.
    const app = harness.makeApp()
    const { wsId, taskId, c } = await seedPolicySwap(app)
    const renamed = await app.call(
      'PATCH',
      `/workspaces/${wsId}/blocks/${taskId}`,
      { title: 'Renamed by a member' },
      bearer(await app.session({ id: c })),
    )
    expect(renamed.status).toBe(200)
  })
}

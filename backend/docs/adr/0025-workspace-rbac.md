# ADR 0025: Workspace-level RBAC & membership

- **Status:** Accepted (implemented)
- **Date:** 2026-07-19
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/workspaces`, `@cat-factory/orchestration`, `@cat-factory/caching`, `@cat-factory/server`, both runtime facades) + frontend (`@cat-factory/app`) + conformance + e2e

## Context

Access control stopped at the **account** tier. `AccountRole` (`admin | developer | product`,
combinable) governed what a member could do, and account membership implicitly granted visibility
into **every** workspace the account owned. There was no `WorkspaceRole`, no workspace-membership
table, and no way to scope a board to a team — a real adoption blocker for any org where separate
teams (or external contractors) share one account but must not see each other's boards, budgets, or
agent runs. Enforcement was also role-shaped rather than permission-shaped: the only check that
existed was `AccountService.requireAdmin`, hand-called per controller.

We wanted an optional **workspace-membership** layer below the account tier, expressed through a
small **permission catalog** rather than scattered role comparisons, with enforcement in ONE shared
place — and with zero behaviour change for every existing deployment (back-compat is a non-goal, but
the migration path should still be "flip a board to restricted", not "migrate all data").

## Decision

An optional workspace-membership tier below the account tier, gated through a fixed permission
catalog and enforced in exactly three shared seams.

- **Permission catalog (kernel vocabulary).** Roles are **fixed** (`admin | member | viewer`; no
  custom roles pre-1.0) and map onto a **seven-permission `WorkspacePermission` union**
  (`workspace.read`, `board.write`, `runs.execute`, `settings.manage`, `integrations.manage`,
  `secrets.manage`, `members.manage`) via a static `WORKSPACE_ROLE_PERMISSIONS` table. The wire
  unions live in `@cat-factory/contracts` (`workspace-members.ts`, re-exported by kernel
  `domain/types.ts`, the `AccountRole` pattern); the map + `resolveWorkspaceAccess` +
  `workspaceRoleAtLeast` are kernel-only server policy (`domain/workspace-access.ts`, pure +
  unit-tested). Seven permissions is exactly the number of distinct route groups the surface has, so
  every route maps unambiguously.

- **Effective-role resolution.** One pure kernel function `resolveWorkspaceAccess` computes a
  `WorkspaceAccess` (`{allowed:true, role, permissions}` or `{allowed:false}`) from the workspace's
  access row, the caller's account roles, and the caller's `workspace_members` row. Precedence
  (lattice `viewer < member < admin`, effective = max of applicable grants): legacy boards
  (`accountId === null`) stay owner-only-`admin`; non-account-members are always denied (account
  membership is a prerequisite, so stale member rows are inert); account `admin` ⇒ workspace `admin`
  (the escape hatch — no lock-out state is reachable); `accessMode: 'account'` gives
  developers/product `member` with a member row as an **upgrade-only overlay** (a `viewer` row is
  ignored, keeping account-mode byte-compatible); `accessMode: 'restricted'` ⇒ the member row's
  role, no row ⇒ denied (404).

- **Data model.** New `workspace_members` table `(workspace_id, user_id, role, created_at,
added_by_user_id)`, PK `(workspace_id, user_id)`, `user`-indexed; `workspaces.access_mode TEXT NOT
NULL DEFAULT 'account'` (the default = zero behaviour change, no data migration). Mirrored across
  both runtimes (D1 `0052_workspace_rbac.sql` ⇄ Drizzle) behind a batch-shaped
  `WorkspaceMemberRepository` (`get`, `listByWorkspace`, `listWorkspaceIdsForUser`, the chunked-`IN`
  `getRolesForUserInWorkspaces`, `upsert`, `remove`, `removeByAccountMembership`) — never a
  per-member point-read loop. `WorkspaceRepository` gained `accessRowOf` (one narrow hot-path read),
  `setAccessMode`, and `linkAccount` (legacy-board auto-heal).

- **Three enforcement seams — never re-derived per controller.**
  1. **Resolution + the 404 hide** in `mountAuthGate` (`server/src/http/authGate.ts`): every
     `/workspaces/:ws/*` request calls the single `loadWorkspaceAccess` (through the
     `workspaceAccess` AppCaches slice), publishes `{role, permissions}` on `c.get('workspaceAccess')`,
     and returns the SAME 404 shape for a denied/absent board (existence is never leaked).
  2. **The viewer write floor**, also in the gate: any non-GET/HEAD method requires `≥ member`,
     covering the whole member tier (`board.write` + `runs.execute`) with zero per-controller code.
     Its sole exemption is the read-only WS-ticket mint.
  3. **The admin-tier permission gate** `requireWorkspacePermission(perm)`
     (`server/src/http/workspaceAccess.ts`): a method-shaped Hono middleware mounted ONCE at the top
     of each admin controller. It gates every write the controller serves (now and future) with that
     one permission while letting reads through, and runs before the handler's 503/lookup so an
     unauthorized member gets a clean 403 without learning whether the integration is wired. Each
     admin controller maps to exactly ONE permission (whole-controller). Two mixed controllers
     (`WorkspaceController`, `WorkspaceMemberController`) use the imperative `requirePermission(c,
perm)` helper per-handler instead. A resolved-but-insufficient caller gets **403 `ForbiddenError`**
     (`DomainErrorCode 'forbidden'`); an unresolved board gets **404** (invisibility vs insufficiency).

- **Caching.** Resolution runs on every workspace request (3 reads folded into one load), so it
  routes through the `workspaceAccess` AppCaches slice (group = workspace id, key = user id, negative
  outcomes cached as values). `DEFAULT_APP_CACHES_PROFILE` enabled (TTL 60s, freshness backstop
  only); `ISOLATE_SAFE_APP_CACHES_PROFILE` **disabled** (our own mutable D1 state, no cross-isolate
  bus — the `repoProjection` class). Invalidation is the coherence story: roster/access-mode/delete
  writes `invalidateGroup(workspaceId)`; account-tier membership writes (`addMember`/`setMemberRoles`/
  invitation accept) `invalidateAll()` via a narrow `onAccountMembershipChanged` callback.

- **List filtering, member API, side doors.** `GET /workspaces` filters SQL-level in `listVisible`
  (both runtimes; JS post-filtering is the banned N+1 class) and annotates each row with the caller's
  effective `viewerRole` via one `getRolesForUserInWorkspaces` batch. `WorkspaceMemberService`
  (`@cat-factory/workspaces`) + `WorkspaceMemberController` serve `GET/POST/PATCH/DELETE
/workspaces/:ws/members` + `PUT /workspaces/:ws/access-mode` (`members.manage`; targets must be
  account members; creator auto-enroll seeds an admin row). Side doors resolved explicitly:
  `/me/environment-handlers/:ws` calls `loadWorkspaceAccess` itself (mounted outside the gate) and
  requires `runs.execute`; the WS ticket gained an audit-only `userId`; `public_api_keys` gained
  provenance-only `created_by_user_id` (mint under `secrets.manage`, no re-resolution — a service
  credential outlives its minter's access).

- **Frontend.** The snapshot carries optional `access: {role, permissions}` (attached from the
  gate context, zero extra reads); the list carries optional `viewerRole`. `useWorkspaceAccess()` is
  the single gating composable (`can(permission)`, `isViewer`, `canManageMembers`; absent access ⇒
  allow-all, dev-open parity). Viewer degradation hides create affordances and disables
  destructive/run/HITL buttons (windows stay readable); board mutation gates at the three shared
  composables (`useBlockDrag`/`useFrameResize`/`useBlockDeletion`) so new callers inherit it.
  `WorkspaceMembersSettings.vue` (a lazily-loaded "Members" settings tab, gated by `canManageMembers`)
  drives the roster; `BoardSwitcher` badges restricted boards. All copy is in `en.json` with real
  translations in every locale.

## Rationale

- **Permission-shaped, not role-shaped, enforcement.** The old `requireAdmin` per-controller pattern
  scattered authz and couldn't express "viewer". A fixed catalog with resolution in one middleware
  makes a forgotten controller fail _safe_ (the floor rejects viewer writes wholesale) and makes new
  routes inherit the correct gate from the mount rather than a central path→permission table that
  silently drifts.
- **`board.write` vs `runs.execute` split even though both resolve to `member`.** Public-API keys /
  machine principals want run execution without board mutation, and a post-1.0 custom-role model will
  want the split — the cost of carrying it now is one string.
- **Roles single-valued (unlike the account tier's CSV).** Workspace roles are a strict hierarchy; a
  set adds no expressive power (`{viewer, admin}` ≡ `admin`) and complicates the max-lattice math and
  the UI. Account roles stay combinable because `product` is orthogonal routing metadata, not a rank.
- **Account membership is a prerequisite, never a grantor across accounts.** Rule 2 fails a stale
  member row closed, and `listVisible`'s membership branch is ANDed with the caller's account ids so
  lists and resolution agree. Account `admin` ⇒ workspace `admin` makes lock-out unreachable, so no
  last-admin protection is needed (self-demotion/removal — "leave" — is permitted).
- **404 for invisibility, 403 for insufficiency.** A denied board returns the exact existing
  not-found shape (a different body leaks existence); a resolved-but-insufficient caller gets 403,
  because they already see the workspace so only capability — not existence — is revealed. The account
  tier's `requireAdmin` 409 is a legacy shape deliberately not copied.
- **The Worker keeps the slice pass-through.** A Worker isolate has no cross-isolate invalidation bus,
  so a TTL'd cache of mutable D1 state would serve stale access after another isolate's write; the
  isolate-safe profile disables the slice and resolution reads live every request.
- **Conformance/e2e MUST run auth-enabled.** Dev-open resolves no access object and allows everything
  by design, so an auth-disabled harness passes every RBAC assertion vacuously — the harnesses run
  the RBAC suite with `AUTH_SESSION_SECRET` set and drive the gate as real signed users.

## Consequences

- **Zero change for existing deployments.** `accessMode: 'account'` behaves byte-for-byte like before
  (member rows are upgrade-only overlays), so no data migration and no opt-in required until a board
  is explicitly restricted.
- **Creator auto-enroll changes rosters.** `WorkspaceService.create` now seeds an admin member row
  for a non-null owner, so a board's owner appears in `listByWorkspace`; the escape-hatch (admin with
  NO row) is exercised by creating a board with a null owner.
- **One caching seam, invalidate on every write.** A raw-repo roster/access-mode write that skips
  `caches.workspaceAccess.invalidateGroup` is a coherence bug on the enabled (Node) profile.
- **Legacy `account_id IS NULL` boards auto-heal on the first member write** (adopted into the owner's
  sole account via `linkAccount`, owner re-asserted as admin); an ambiguous owner is a `ValidationError`
  to link the board explicitly.
- **Known residual gaps, accepted pre-1.0:** a revoked member's _already-open_ WebSocket keeps
  streaming until its next mint (the ticket TTL bounds new mints; the clean follow-up is the events
  hub dropping a workspace's sockets on the membership-change signal, never per-message checks); and
  whoever adds the (still-missing) account-member-removal endpoint must call
  `removeByAccountMembership` + `invalidateAll()`.

### Deliberately NOT pursued

- Custom / user-defined roles and per-permission grants (the catalog is shaped so they can be added
  without re-splitting).
- Cross-account workspace sharing (grants to users outside the owning account — a sharing feature with
  different trust maths).
- An account-tier `AccountPermission` catalog, realigning `requireAdmin`'s 409 to a 403
  `ForbiddenError`, and a frontend `useAccountAccess()` — folding the account tier in now would triple
  the blast radius for zero user-visible gain. `AccountRole` answers "what can you do to the tenant";
  `WorkspaceRole` answers "what can you do inside one board"; they meet at exactly two seams owned by
  `resolveWorkspaceAccess`.
- Per-workspace machine-token scoping and per-message WS authorization.
- A "billing-blind viewer" (viewers are account members already and `workspace.read` covers run/spend
  reads).

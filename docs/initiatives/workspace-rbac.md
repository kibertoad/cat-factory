# Initiative: workspace-level RBAC & membership

**Status:** in progress (slices 1–5 landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Access control today stops at the **account** tier: `AccountRole` (`admin | developer |
product`, combinable — `backend/packages/kernel/src/domain/types.ts`) governs what a member
can do, and account membership implicitly grants visibility into **every workspace** the
account owns. There is no `WorkspaceRole`, no workspace-membership table, and no way to
scope a board to a team — a real adoption blocker for any org where separate teams (or
external contractors) share one account but must not see each other's boards, budgets, or
agent runs. Enforcement is also role-shaped rather than permission-shaped: the only check
that exists is `AccountService.requireAdmin`, hand-called per controller.

End state: an optional **workspace membership** layer below the account tier, expressed
through a small **permission catalog** rather than scattered role comparisons. An account
admin can restrict a workspace to an explicit member list (with per-member workspace
roles); an unrestricted workspace keeps today's behaviour (all account members).
Enforcement lives in ONE place — the shared authz middleware — not per controller.

The full design below was validated against the code (the gate, `AccountService`, both
schema files, the route inventory, the `AppCaches` seam, the conformance suite) and is
binding for every slice; deviations discovered during implementation go into
"Conventions & gotchas" so later slices inherit them.

## Design

### 1. Permission catalog (kernel vocabulary, not scattered role checks)

Roles stay **fixed** (`admin | member | viewer`; no custom roles pre-1.0), and map onto a
**seven-permission `WorkspacePermission` union** via a static table:

```ts
export type WorkspaceRole = 'admin' | 'member' | 'viewer'
export type WorkspacePermission =
  | 'workspace.read' // snapshot, runs/spend/usage/llm-metrics/agent-context/kaizen reads,
  // notifications list, artifacts blobs, spec, consensus, per-workspace
  // models, events stream + ticket mint
  | 'board.write' // blocks CRUD/move/reparent/archive/dependencies, epics, service
  // mount/unmount, initiatives CRUD + planning, pipelines CRUD
  | 'runs.execute' // execution start/stop/merge/restart, agent-run retry/stop, recurring
  // pipelines, ALL HITL windows (requirement/clarity/brainstorm reviews,
  // doc-interview, fork-decision, pr-review, follow-ups, human-review/test,
  // visual-confirm), spend resume, notification act/dismiss
  | 'settings.manage' // workspace settings PUT, board rename/description/delete, tracker
  // settings, model presets, risk policies / merge presets, prompt-fragment
  // library writes, observability / release-health / incident-enrichment
  | 'integrations.manage' // GitHub/Slack/environments/runner-pool/task-source/document-source
  // connections, package registries, shared stacks, bootstrap + reference
  // architectures, sandbox, preview config
  | 'secrets.manage' // vendor credentials, workspace api-keys, public-api-keys, test-secrets
  | 'members.manage' // workspace member CRUD + access-mode flip

export const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  viewer: ['workspace.read'],
  member: ['workspace.read', 'board.write', 'runs.execute'],
  admin: [
    /* all seven */
  ],
}
```

- **Granularity rationale.** Seven permissions is exactly the number of distinct route
  groups the surface has (see the enforcement table in §6) — every route maps
  unambiguously. Coarser (read/write/admin) would force public-API-key scoping and any
  future custom roles to re-split; finer (per-module) explodes the table for zero present
  benefit since the three fixed roles collapse the middle tier anyway. `board.write` vs
  `runs.execute` are distinguished even though both resolve to `member`, because
  public-API keys / machine principals want run execution without board mutation, and a
  post-1.0 custom-role model will want the split — the cost of carrying it now is one
  string.
- **HITL actions = `runs.execute`** (decision): approving a review / fork decision /
  human test _advances a run_ — the member surface. Pipelines CRUD = `board.write`
  (board configuration, authored by developers). Recurring pipelines = `runs.execute`
  (scheduling runs).
- **Placement.** The wire unions (`workspaceRoleSchema`, `workspacePermissionSchema`,
  `workspaceAccessModeSchema`, the `WorkspaceMember` entity) live in
  `@cat-factory/contracts` (new `src/workspace-members.ts`) and are re-exported by kernel
  `domain/types.ts` — the exact pattern `AccountRole` uses. The `WORKSPACE_ROLE_PERMISSIONS`
  map and the resolution logic are kernel-only (`backend/packages/kernel/src/domain/workspace-access.ts`,
  pure + unit-testable): server policy, not wire shape. Rejected: defining the catalog in
  `@cat-factory/server` — the workspaces-package services and the conformance suite need
  it below the HTTP layer.

### 2. Effective-role resolution

One pure function in kernel, one call site in the gate:

```ts
export type WorkspaceAccess =
  | { allowed: true; role: WorkspaceRole; permissions: ReadonlySet<WorkspacePermission> }
  | { allowed: false } // presented as 404 — never leak existence

export function resolveWorkspaceAccess(input: {
  userId: string
  workspace: {
    accountId: string | null
    ownerUserId: string | null
    accessMode: WorkspaceAccessMode
  }
  accountRoles: AccountRole[] // [] when not an account member
  memberRole: WorkspaceRole | null // the workspace_members row, if any
}): WorkspaceAccess
```

Precedence (the lattice is `viewer < member < admin`; effective role = max of applicable
grants):

1. **Legacy board (`accountId === null`)**: `ownerUserId === userId` ⇒ `admin`; else
   denied. Preserves today's owner-only gate byte-for-byte.
2. **Not an account member** (`accountRoles` empty) ⇒ **denied**, regardless of any
   `workspace_members` row. Account membership is a _prerequisite_ — the workspace tier
   restricts within an account, it never grants across accounts. This also makes orphaned
   member rows (e.g. after a future account-member removal) inert and fail-closed.
3. **Account `admin`** ⇒ workspace `admin` (the escape hatch; no lock-out state is
   possible). Covers the personal-account owner automatically — `ensurePersonalAccount`
   grants `['admin']`, so no special case.
4. **`accessMode: 'account'`**: account `developer`/`product` ⇒ workspace `member`
   (today's behaviour). A `workspace_members` row is honoured as an **upgrade-only
   overlay** (max) — an account admin can appoint a workspace `admin` without flipping
   the board to restricted. A `viewer` row in account mode is _ignored_ (restriction is
   opt-in via `accessMode`, not per-user demotion — keeps `account` mode byte-compatible).
5. **`accessMode: 'restricted'`**: effective role = the member row's role; no row (and
   not account admin) ⇒ denied (404).

Non-session principals: **dev-open / auth disabled** — the gate's existing
`if (!user) return next()` stands; no access object is set and `requirePermission`
treats absent-access-with-no-user as allow-all (mirrors `WorkspaceVisibility = null`).
**Machine tokens** (`/internal/*`) stay account-granular (`scope.accountIds`),
self-authenticated in-controller. **Container tokens** (LLM proxy `/v1`, harness
artifact ingest) unchanged (§7).

The second `mountAuthGate` middleware (`backend/packages/server/src/http/authGate.ts`)
becomes the single resolution point: it loads the workspace access row + the caller's
account roles + the member row (through the cache, §5), calls `resolveWorkspaceAccess`,
and on success sets `c.set('workspaceAccess', { workspaceId, role, permissions })` — a
new `AppEnv` `Variables` entry in `backend/packages/server/src/http/env.ts`. Denied ⇒ the
existing 404 JSON shape, unchanged. Controllers **consume, never re-derive**; carrying
`workspaceId` in the object lets the helper assert it matches the route's workspace.

### 3. Data model

**`workspace_members`** (new table, both runtimes):

| column             | type                    | notes                                                                          |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------ |
| `workspace_id`     | TEXT NOT NULL           | FK → `workspaces(id)` **ON DELETE CASCADE** (a deleted board takes its roster) |
| `user_id`          | TEXT NOT NULL           | FK → `users(id)` **ON DELETE RESTRICT** (mirrors `memberships.user_id`)        |
| `role`             | TEXT NOT NULL           | single value: `admin \| member \| viewer`                                      |
| `created_at`       | INTEGER/BIGINT NOT NULL | epoch ms                                                                       |
| `added_by_user_id` | TEXT NULL               | audit: who granted; null for system grants (creator auto-enroll); no FK        |

PK `(workspace_id, user_id)`; index `idx_workspace_members_user (user_id)` (drives
`listWorkspaceIdsForUser` and the visibility subquery).

- **`role` is single-valued, deliberately unlike the account tier's CSV.** Account roles
  are combinable because `product` is orthogonal metadata (task routing), not a rank.
  Workspace roles are a strict hierarchy — a set adds no expressive power
  (`{viewer, admin}` ≡ `admin`) and complicates the max-lattice math and the UI.
- **`workspaces.access_mode TEXT NOT NULL DEFAULT 'account'`** — new column; the default
  means zero behaviour change for every existing row, no data migration.
- **Migrations**: D1 `backend/runtimes/cloudflare/migrations/0052_workspace_rbac.sql`
  (0051 was taken by `0051_password_reset_tokens_expiry_index.sql`) ⇄ Drizzle
  `backend/runtimes/node/src/db/schema.ts` + `pnpm db:generate`. New table ⇒ FKs are
  born clean, no heal-then-constrain needed.
- **Kernel port** (`backend/packages/kernel/src/ports/workspace-member-repositories.ts`),
  batch-shaped — never a per-member point-read loop:

  ```ts
  export interface WorkspaceMemberRepository {
    get(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null>
    listByWorkspace(workspaceId: string): Promise<WorkspaceMemberRecord[]>
    listWorkspaceIdsForUser(userId: string): Promise<string[]>
    /** ONE chunked-IN read to annotate a workspace LIST with the caller's role. */
    getRolesForUserInWorkspaces(
      userId: string,
      workspaceIds: string[],
    ): Promise<Map<string, WorkspaceRole>>
    upsert(member: WorkspaceMemberRecord): Promise<void>
    remove(workspaceId: string, userId: string): Promise<void>
    /** Hygiene cascade when an account membership is removed: one DELETE joined on workspaces.account_id. */
    removeByAccountMembership(accountId: string, userId: string): Promise<void>
  }
  ```

  Implemented in both runtimes with conformance assertions.

- **`WorkspaceRepository`** gains `accessRowOf(id): { accountId, ownerUserId, accessMode } | undefined`
  (one narrow hot-path read replacing the gate's `accountOf` call) and
  `setAccessMode(id, mode)`. The contracts `workspaceSchema` gains `accessMode`.

### 4. Workspace list filtering (`GET /workspaces`)

Extend `WorkspaceVisibility` (kernel `ports/repositories.ts`) — SQL-level in
`listVisible`, both runtimes; JS post-filtering is rejected (the banned N+1 class):

```ts
export type WorkspaceVisibility = {
  accountIds: string[]
  adminAccountIds: string[]
  ownerUserId: string
  userId: string
} | null
```

Predicate: unrestricted boards in my accounts (`account_id IN (accountIds) AND
access_mode = 'account'`) OR any board in accounts where I'm admin
(`account_id IN (adminAccountIds)` — the escape hatch, includes restricted) OR explicit
membership (`id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)`,
ANDed with `account_id IN (accountIds)` so an orphaned row in a foreign account can't
resurface a board the resolution would deny) OR legacy boards I own
(`account_id IS NULL AND owner_user_id = ?`).

`AccountService` gains `accessibleAccountScopes(userId): Promise<{ accountIds, adminAccountIds }>`,
derived from the single existing `membershipRepository.listByUser` read (no extra query).
The list route annotates each returned workspace with the caller's effective role
(optional `viewerRole` on the wire) using ONE `getRolesForUserInWorkspaces` batch + the
in-memory account-role map.

### 5. Caching — the `workspaceAccess` AppCaches slice

Resolution runs on **every** `/workspaces/:ws/*` request (3 reads: access row, account
membership, member row) → one slice on the app cache seam, never a hand-rolled Map:

- **Handle**: `workspaceAccess: GroupCacheHandle<{ access: WorkspaceAccess }>` on the
  kernel `AppCaches` port; the _denied_ outcome caches as a value too (negative caching —
  the wrap convention, since layered-loader treats bare `null` as unresolved).
- **Key/group**: group = `workspaceId`, key = `userId`. Everything (access row, account
  roles, member row) is resolved inside the load, so a hit costs zero reads; a workspace
  never changes accounts.
- **Profiles** (`backend/packages/caching/src/appCaches.ts`): `DEFAULT_APP_CACHES_PROFILE`
  enabled, TTL 60s (freshness backstop only — invalidation is the coherence story);
  `ISOLATE_SAFE_APP_CACHES_PROFILE` **`enabled: false`** — our own mutable D1 state with
  no cross-isolate bus, same class as `repoProjection` / `accountModelPolicy`.
- **Invalidation, after commit, at every write**: workspace-member writes
  (add/setRole/remove), `setAccessMode`, workspace delete ⇒ `invalidateGroup(workspaceId)`;
  account-tier membership writes (`AccountService.addMember`, `setMemberRoles`,
  invitation accept) ⇒ coarse **`invalidateAll()`** (rare management actions;
  over-invalidation is safe, and enumerating an account's workspaces just for
  invalidation isn't worth a port method).

### 6. Enforcement architecture

**Decision: a middleware floor + a `requirePermission` helper.** Rejected:
route-contract `requires:` metadata (server enforcement policy leaked into the SPA-shared
wire layer, and some routes aren't contract-built at all) and a path-pattern map in the
middleware (a ~200-route shadow table that silently drifts).

1. **Floor in `mountAuthGate`** (after resolution): denied ⇒ 404 (existing shape);
   **any non-GET/HEAD method requires `role >= member`** — a `viewer` passes only reads.
   Exactly one write is read-equivalent and allowlisted:
   `POST /workspaces/:ws/events/ticket` (mints a read-only stream ticket). This covers
   the entire member tier (`board.write`, `runs.execute`) with **zero per-controller
   code** — a forgotten controller check fails safe.
2. **`requirePermission(c, permission)`** (`backend/packages/server/src/http/workspaceAccess.ts`)
   for the **admin-tier groups only**: reads `workspaceAccess`; absent access with no
   user ⇒ allow (dev-open); otherwise throws the new kernel `ForbiddenError`
   (`DomainErrorCode 'forbidden'`) mapped to **403** in `errorHandler.ts` + contracts
   `errorResponses`. 403 (not 404) is correct here: the caller already _sees_ the
   workspace, so only capability — not existence — is revealed. (The account tier's
   `requireAdmin` → 409 is a legacy shape; do not copy it.)

Route-group → permission table (the slice-6 worklist; groups under
`/workspaces/:workspaceId` unless noted):

| Route group                                                                                                                                                                                            | Permission                                      | Enforced by                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------- |
| Snapshot, spend/usage, llm-metrics, agent-context, kaizen reads, notifications list, artifacts blobs, spec, consensus, per-workspace models, events WS + ticket mint                                   | `workspace.read`                                | resolution itself + floor   |
| Blocks CRUD/move/reparent/archive/dependencies, epics, service mount/unmount, initiatives CRUD + planning, pipelines CRUD                                                                              | `board.write`                                   | middleware floor (≥ member) |
| Execution start/stop/merge/restart, agent-run retry/stop, recurring pipelines, all HITL windows, spend resume, notifications act/dismiss                                                               | `runs.execute`                                  | middleware floor (≥ member) |
| `PUT /settings`, board rename/description/delete, tracker-settings, model presets, risk policies / merge presets, prompt-fragment library writes, observability / release-health / incident-enrichment | `settings.manage`                               | `requirePermission`         |
| GitHub/Slack/environments/runner-pool/task-source/document-source connections, package-registries, shared-stacks, sandbox, bootstrap + reference-architectures, preview config                         | `integrations.manage`                           | `requirePermission`         |
| Vendor credentials, workspace api-keys, public-api-keys, test-secrets                                                                                                                                  | `secrets.manage`                                | `requirePermission`         |
| `GET/POST/PATCH/DELETE /members`, `PUT /access-mode` (§8)                                                                                                                                              | GET: `workspace.read`; writes: `members.manage` | `requirePermission`         |

### 7. Side doors

| Surface                                                                                                               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **WS ticket mint** (`POST /workspaces/:ws/events/ticket`)                                                             | Passes the gate ⇒ resolution applies (any role — viewers may read runs). The ticket (`auth/wsTicket.ts`) gains `userId` for audit; **verify stays membership-blind** — the 60s TTL bounds post-revocation minting and the stream carries only read-tier data.                                                                                                                                                                                                                                                                                                                                          |
| **Open sockets after revocation**                                                                                     | A revoked member's already-open socket keeps streaming. Accepted pre-1.0; the clean follow-up is the events hub dropping a workspace's sockets on the membership-change signal (piggyback the cache invalidation), never per-message checks.                                                                                                                                                                                                                                                                                                                                                           |
| **Public API keys** (`/api/v1/*`)                                                                                     | Key auth in-controller, unchanged. `public_api_keys` gains `created_by_user_id` (audit + UI); **minting** requires `secrets.manage`. **A key does NOT die when its minter loses access**: it is a workspace-scoped _service_ credential and external integrations must not break on offboarding — revocation is an explicit admin action; the keys UI surfaces the minter. Rejected: re-resolving the minter per call (a membership read on machine traffic, and semantically wrong — the authority is the workspace, granted at mint time). Coordinate the column with `public-api-expansion` scopes. |
| **`/me/environment-handlers/:workspaceId`** (mounted at `/` — bypasses the workspace gate entirely today, a real gap) | The controller calls the same shared resolution helper the middleware uses and requires `runs.execute`; no access ⇒ 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Harness artifact ingest** (container token)                                                                         | Unchanged. The token is minted per-run by a dispatch an authorized (≥ member) user initiated — authorization happened at run start; revocation stops _new_ initiations, not in-flight machine work.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **`/internal` machine API**                                                                                           | Unchanged; machine tokens stay account-granular (`scope.accountIds`). Per-workspace machine scoping is explicitly out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### 8. Member management API

New `WorkspaceMemberService` (`backend/packages/workspaces/src/modules/workspaces/`,
beside `WorkspaceService`) + `workspaceMemberController` (`@cat-factory/server`) +
contracts routes (`contracts/src/routes/workspace-members.ts`):

| Route                                            | Caller            | Semantics                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workspaces/:ws/members`                    | any resolved role | Roster enriched with user display details via one `userRepository.listByIds` batch (the `AccountService.members` pattern).                                                                                                                                    |
| `POST /workspaces/:ws/members` `{userId, role}`  | `members.manage`  | **Target must be a member of the owning account** (else `ValidationError`) — contractors join the account first (existing invitation flow), then get scoped. Rejected: cross-account grants (a sharing feature with different trust maths). Upsert semantics. |
| `PATCH /workspaces/:ws/members/:userId` `{role}` | `members.manage`  | Role change. **No last-admin protection needed** — account admins always resolve to workspace admin, so lock-out is impossible; self-demotion/removal is permitted ("leave").                                                                                 |
| `DELETE /workspaces/:ws/members/:userId`         | `members.manage`  | Remove row + invalidate group.                                                                                                                                                                                                                                |
| `PUT /workspaces/:ws/access-mode` `{accessMode}` | `members.manage`  | Separate route (different permission than `settings.manage`). Flipping to `restricted` needs no auto-enroll of the actor (they're an account admin or already hold the row that let them call this).                                                          |

**Creator auto-enroll**: `WorkspaceService.create` inserts a `workspace_members` row
(`role: 'admin'`, `addedByUserId: null`) for the creator — harmless in `account` mode
(upgrade-only overlay), and a non-admin account member keeps admin control of boards they
created even if the board is later restricted.

### 9. Frontend

- **Delivery on the snapshot**: `workspaceSnapshotSchema` gains optional
  `access: { role, permissions }`, attached from `c.get('workspaceAccess')` in the shared
  `WorkspaceController` GET/POST handlers — zero extra reads, runtime-symmetric by
  construction. Rejected: a `GET /workspaces/:id/access` endpoint (second round-trip on
  every board open + a second source of truth). Absent on the wire = dev-open = allow
  all. The workspace list gains optional `viewerRole` (§4).
- **`useWorkspaceAccess()` composable** (`frontend/app/app/composables/`): `role`,
  `can(p: WorkspacePermission)`, `isViewer`, …; absent access ⇒ `can()` true (dev-open
  parity with the backend). This is the central helper replacing ad-hoc checks for
  _workspace_-scoped affordances; the existing account-scoped
  `activeAccount?.roles?.includes('admin')` call sites stay account-scoped (see §10).
- **Viewer degradation** (hide/disable, never client-enforce): board editing
  (drag/create/context menus) on `can('board.write')`; run start/stop + HITL action
  buttons on `can('runs.execute')` (windows stay _visible_ read-only); settings panels
  per admin permission; disabled affordances carry tooltips.
- **Membership UI**: `WorkspaceMembersSettings.vue` beside `AccountTeamSettings.vue` —
  restrict toggle (`accessMode`), roster with role selects, add-member picker sourced
  from the account roster, remove. Shown only when `can('members.manage')`.
- **Picker filtering is server-side** (§4); the SPA renders what `GET /workspaces`
  returns, badging restricted boards via `viewerRole`.
- **i18n**: all new copy in `en.json` + real translations in every locale
  (de/es/fr/he/it/ja/pl/tr/uk) in the same PR (the parity gate).

### 10. Account-tier relationship

The account tier stays as-is in this initiative — folding `requireAdmin`/`hasRole` into a
unified `AccountPermission` catalog now would triple the blast radius for zero
user-visible gain. End state to record in the closing ADR: `AccountRole` answers _"what
can you do to the tenant"_ (billing, roster, account credentials); `WorkspaceRole`
answers _"what can you do inside one board"_; they meet at exactly two seams, both owned
by `resolveWorkspaceAccess` — account membership as prerequisite, account `admin` ⇒
workspace `admin`. `product` remains data-only. Deferred follow-ups: an
`AccountPermission` catalog in the same kernel module, `requireAdmin`'s 409 realigned to
403 `ForbiddenError`, a frontend `useAccountAccess()`.

### 11. Testing

- **Conformance** (`backend/internal/conformance`, new `workspace-access` suite run by
  both runtimes — Worker/real D1 in workerd, Node + local/real Postgres): seed an org
  with admin A, developers B and C; A creates workspace W. Assert: restricted W ⇒ C gets
  **404** on the snapshot (exact not-found shape) and W absent from C's `GET /workspaces`;
  B as `viewer` ⇒ reads 200, block create + run start **403** (floor), ticket mint 200;
  B as `member` ⇒ writes 200, `PUT /settings` + `POST /members` **403**; A with **no
  member row** ⇒ full access incl. members CRUD (escape hatch); `accessMode` flip +
  member add/remove visible on the immediately following request (cache coherence);
  `/me/environment-handlers/:ws` 404 for C; repository assertions
  (`getRolesForUserInWorkspaces` batch, all four `listVisible` branches,
  `removeByAccountMembership`).
- **Unit**: kernel decision-table tests over `resolveWorkspaceAccess` (legacy/owner,
  non-account-member with stale row, admin escape, account-mode upgrade-only overlay,
  restricted no-row); `WorkspaceMemberService` rules; server floor/helper specs.
- **Frontend**: `useWorkspaceAccess` spec + workspace-store hydration of `access`.
- **e2e** (`backend/internal/e2e`, data-testid only, seed via REST, live-push
  assertions): admin restricts a board → a second member sees it vanish from the live
  picker and direct navigation 404s; admin re-adds them as viewer → board appears with
  editing affordances disabled and no run-start button.

## Prioritized checklist

| #   | Slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status  | PR    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| 1   | **Contracts + kernel vocabulary**: `workspaceRoleSchema` / `workspacePermissionSchema` / `workspaceAccessModeSchema` + `WorkspaceMember` wire shape (`contracts/src/workspace-members.ts`); `workspaceSchema.accessMode`; kernel `domain/workspace-access.ts` (`WORKSPACE_ROLE_PERMISSIONS`, `resolveWorkspaceAccess`, `workspaceRoleAtLeast`) + decision-table tests; `ForbiddenError` + 403 mapping                                                                                                         | ✅ done | #1159 |
| 2   | **Persistence**: D1 `0052_workspace_rbac.sql` ⇄ Drizzle + `pnpm db:generate` (`workspace_members`, `workspaces.access_mode`); `WorkspaceMemberRepository` port + both impls (incl. `getRolesForUserInWorkspaces`, `removeByAccountMembership`); `WorkspaceRepository.accessRowOf` + `setAccessMode`; board-delete cascade; conformance repo assertions                                                                                                                                                        | ✅ done | #1159 |
| 3   | **Resolution in the gate**: `mountAuthGate` resolves `WorkspaceAccess` (escape hatch, legacy branch, 404 shape unchanged), sets `workspaceAccess` on the context (`env.ts`), **viewer write floor** (non-GET ⇒ ≥ member; ticket-mint allowlist); `WorkspaceVisibility` extension + `listVisible` both runtimes + `AccountService.accessibleAccountScopes`; list `viewerRole` annotation (batch); snapshot/create attach `access`; creator auto-enroll; conformance (404, floor, escape hatch, list filtering) | ✅ done | #1166 |
| 4   | **`workspaceAccess` AppCaches slice**: kernel handle + wrap type, both profiles (isolate-safe: disabled), read-through in the gate, invalidation at the write sites that exist today (workspace delete ⇒ `invalidateGroup`; account-membership writes — add/set-roles/invite-accept ⇒ `invalidateAll`), cache-coherence conformance assertion                                                                                                                                                                 | ✅ done |       |
| 5   | **Member management API**: `WorkspaceMemberService` (only-account-members rule), `workspaceMemberController` + contracts routes (`GET/POST/PATCH/DELETE /members`, `PUT /access-mode`), `requirePermission` helper (`http/workspaceAccess.ts`), **`caches.workspaceAccess.invalidateGroup(ws)` after every roster/access-mode write** (slice 4 landed the slice + delete/account-tier invalidation; these group invalidations belong here), conformance member-CRUD + access-mode cache-coherence assertions  | ✅ done | #1176 |
| 6   | **Admin-tier enforcement pass**: `requirePermission('settings.manage' \| 'integrations.manage' \| 'secrets.manage')` across the §6 table's admin route groups; conformance: member 403 on settings/integrations/secrets                                                                                                                                                                                                                                                                                       | ⬜ todo |       |
| 7   | **Side doors**: `/me/environment-handlers/:ws` through shared resolution (`runs.execute`, 404); WS ticket gains `userId`; `public_api_keys.created_by_user_id` (both runtimes) + mint under `secrets.manage` + minter in the keys UI                                                                                                                                                                                                                                                                          | ⬜ todo |       |
| 8   | **SPA read side**: `useWorkspaceAccess()` composable, store hydration of `access` / `viewerRole`, viewer read-only degradation (board editing, run starts, HITL actions), settings nav gating, i18n (en + all locales)                                                                                                                                                                                                                                                                                        | ⬜ todo |       |
| 9   | **SPA membership management**: `WorkspaceMembersSettings.vue` (restrict toggle, roster, role select, add from account roster, remove), picker badges, i18n (all locales)                                                                                                                                                                                                                                                                                                                                      | ⬜ todo |       |
| 10  | **e2e spec** (restricted board vanishes live; viewer read-only) + convert this tracker → ADR `backend/docs/adr/0024-workspace-rbac.md` and `git rm` the tracker                                                                                                                                                                                                                                                                                                                                               | ⬜ todo |       |

Dependencies: 3 needs 1+2; 4–7 need 3; 8–9 need 3 (8 is usable before 5/6 land — the
floor already returns 403s); 10 last. Every slice ships a changeset (contracts / kernel /
server / workspaces / caching / app + both runtimes are versioned packages).

## Conventions & gotchas

- **Default-open, opt-in restriction.** `accessMode: 'account'` must behave byte-for-byte
  like today so existing deployments see zero change; member rows in account mode are
  **upgrade-only overlays** — a `viewer` row never demotes anyone until the board is
  restricted. No data migration needed (pre-1.0, back-compat is a non-goal anyway).
- **One enforcement point; the floor is method-shaped, the helper is permission-shaped.**
  The middleware resolves the effective role once and rejects viewer writes wholesale
  (non-GET ⇒ ≥ member); ONLY the admin-tier route groups add `requirePermission` in
  controllers. A controller that re-derives membership itself is a smell.
- **404, not 403, for invisibility — 403 for insufficiency.** No access at all ⇒ the
  exact existing not-found JSON shape (a different body leaks existence). Resolved but
  insufficient ⇒ 403 `ForbiddenError`. The account tier's `requireAdmin` 409 is legacy;
  don't copy it into workspace enforcement.
- **Cache through the seam, invalidate on every write.** The `workspaceAccess` slice
  (group = workspaceId, key = userId, negative outcomes cached as values) is the only
  cache; the Worker profile keeps it **pass-through** (own mutable D1 state, no
  cross-isolate bus) — do not "fix" the Worker's per-request reads with an in-isolate TTL.
- **Account membership is a prerequisite, never bypassed.** A `workspace_members` row in
  an account the user no longer belongs to is fail-closed by resolution rule 2, and the
  `listVisible` membership branch is ANDed with the caller's account ids so lists agree.
- **Account-member removal must cascade.** Whoever adds the (currently missing)
  account-member-removal endpoint must call
  `workspaceMemberRepository.removeByAccountMembership` + `caches.workspaceAccess.invalidateAll()`.
- **Snapshot redaction interplay**: `redactFrames.ts` (personal-PAT frame redaction) is
  orthogonal and stays — the `access` field is attached alongside it; a workspace `admin`
  role does NOT bypass PAT-based frame redaction (repo reachability ≠ role).
- **Viewers see spend and run streams — intentional.** They're account members already
  and `workspace.read` covers run reads; revisit only if a "billing-blind viewer"
  requirement appears. The real gap is _revoked_ members' already-open sockets (ticket
  TTL only bounds new mints) — follow-up: the events hub drops a workspace's sockets on
  the membership-change signal; never per-message checks.
- **Revocation stops new initiations, not in-flight machine work.** Recurring pipelines
  and running containers continue (container tokens; schedule ownership is the
  workspace). Killing a revoked user's schedule is an explicit admin cleanup, not an
  authz side effect.
- **Machine tokens stay account-granular** (`scope.accountIds`); per-workspace machine
  scoping is out of scope.
- **Conformance/e2e must run auth-enabled** — dev-open resolves no access object and
  allows everything by design, so an auth-disabled harness vacuously passes every RBAC
  assertion.
- **Drizzle snapshot DAG**: slice 2's migration will conflict with any
  concurrently-landed migration — use `scripts/rebase-migration-snapshot.mjs`, never
  hand-merge snapshots.
- **Slice 3 — resolution helper + wiring.** The gate calls ONE shared
  `loadWorkspaceAccess(container, workspaceId, userId)` (`server/src/http/workspaceAccess.ts`):
  `accessRowOf` → (for account boards) `accountService.rolesFor` + `workspaceService.memberRoleOf`
  → the pure `resolveWorkspaceAccess`. Returns `null` for a MISSING board (the gate passes through
  so the handler 404s as before) vs a `{allowed:false}` DENIAL (the gate 404s). Slice 4 wraps THIS
  function in the `workspaceAccess` cache; slice 7's `/me/environment-handlers` reuses it. The
  member repo is threaded via `CoreDependencies.workspaceMemberRepository` (optional) →
  `WorkspaceService` (so `createCore(dependencies)` wires it for free); the facades build it in
  their `dependencies` bag (D1 inline; Node/local via `createDrizzleRepositories`).
- **Creator auto-enroll changes existing rosters.** `WorkspaceService.create` now seeds an admin
  member row for a non-null `ownerUserId`, so any test/flow that creates an org board via a signed
  owner sees that owner in `listByWorkspace`. The slice-2 conformance roster test was relaxed to
  `arrayContaining`. To exercise the account-admin escape hatch (admin with NO row), create the
  board with a **null** owner (the conformance `createWorkspaceInAccount(accountId, null, …)` seam).
- **Conformance MUST run auth-enabled.** A dev-open harness resolves no access object and passes
  every RBAC assertion vacuously, so `AUTH_SESSION_SECRET` is now set in ALL THREE harness envs
  (Node `TEST_ENV`, Worker vitest bindings, local already had it) — harmless because with no OAuth/
  password provider `config.auth.enabled` stays false and token-less requests still pass dev-open.
  `ConformanceApp` gained `authEnabled` + `session(user)` (mints a real `Bearer` via the shared
  `mintSession`) + `createWorkspaceInAccount`; `defineWorkspaceRbacSuite` drives the gate as real
  signed users. The mothership harness reports `authEnabled:false` (it does not run the suite).
- **Slice 4 — cache read-through + invalidation ownership.** The `workspaceAccess` slice wraps
  `loadWorkspaceAccess` (`server/src/http/workspaceAccess.ts`): group = workspace id, key = user
  id, and BOTH a denial and a missing board cache as values (`WorkspaceAccessCacheValue.access:
WorkspaceAccess | null`). The slice landed invalidation ONLY at the write paths that exist
  today: `WorkspaceService.delete` (`invalidateGroup`, wired via `caches.workspaceAccess`), and the
  account-tier membership writes `AccountService.addMember` / `setMemberRoles` +
  `InvitationService.accept` (a narrow `onAccountMembershipChanged` callback the container wires to
  `invalidateAll()`, mirroring `onAccountBudgetChanged`). The **member-roster + access-mode writes
  don't exist yet — they arrive with the slice-5 member-management service**, and that service MUST
  call `caches.workspaceAccess.invalidateGroup(workspaceId)` after each roster/access-mode write (a
  raw-repo write does NOT invalidate). Until then the RBAC conformance suite uses distinct users
  for the viewer/member floor case (each resolves fresh) rather than upgrading one user via a raw
  upsert-then-live-read, which the cache would otherwise serve stale. The Worker keeps the slice
  pass-through (isolate-safe profile), so on that facade resolution reads live every request.
- **Slice 5 — member-management service + `requirePermission`.** `WorkspaceMemberService`
  (`@cat-factory/workspaces`) owns the roster (`list`/`add`/`setRole`/`remove`) + `setAccessMode`,
  and is built in `createCore` ONLY when `workspaceMemberRepository` is wired (both facades wire it;
  absent ⇒ `Core.workspaceMemberService` is undefined and the controller 503s). It takes the same
  `caches.workspaceAccess` handle `WorkspaceService` does and calls `invalidateGroup(workspaceId)`
  after EVERY write — that group invalidation (not the TTL) is what makes a live roster/access-mode
  change visible on the immediately-following request, which the Node conformance asserts against the
  enabled cache. The only-account-members rule reads `workspaceRepository.accessRowOf` for the owning
  account then `membershipRepository.get`; a non-member is a `ValidationError` (422, not 400 — the
  domain error map), a legacy `account_id IS NULL` board refuses member management. `requirePermission(c, perm)`
  (`server/src/http/workspaceAccess.ts`) is the admin-tier helper the writes call with `members.manage`;
  it consumes `c.get('workspaceAccess')` (never re-derives), allows dev-open (no user + no access
  object), and throws `ForbiddenError` (403) otherwise. The member routes use ABSOLUTE
  `/workspaces/:ws/members` + `/access-mode` paths (like the workspace-root contracts), so the
  controller mounts at `/`, NOT at `/workspaces/:workspaceId`. The roster GET adds no
  `requirePermission` — gate resolution already guarantees ≥ viewer (`workspace.read`).
- **The viewer write floor is method-based, and the ticket mint is its SOLE exemption — on
  purpose.** The floor rejects EVERY non-GET method under `/workspaces/:ws/*` for a `viewer`,
  allowlisting only `POST …/events/ticket`. A repo audit found ~13 other non-GET routes that
  don't persist anything (the `detect`/`plan`/`search`/`test`/`validate`/`preflight`/`probe`
  endpoints that prefill a create/edit form or probe an integration connection). These were
  deliberately NOT allowlisted: they belong to the `member`+ authoring / integration-setup
  surface, not to read-only viewing, and the SPA already gates their affordances by permission —
  so a viewer never reaches them. Do NOT "fix" a viewer 403 on one of those by widening the
  allowlist to "read-equivalent POST" as a class; the ticket mint is exempt only because it is
  the one write the pure _viewing_ experience needs (the live stream). Add a new exact-path
  exemption only for a genuinely viewing-required write.

## Out of scope

- Custom / user-defined roles and per-permission grants (post-1.0; the catalog is shaped
  so they can be added without re-splitting).
- Cross-account workspace sharing (grants to users outside the owning account).
- Account-tier `AccountPermission` catalog + `requireAdmin` 409→403 alignment +
  `useAccountAccess()` (recorded follow-up, §10).
- Per-workspace machine-token scoping; per-message WS authorization.
- A "billing-blind viewer" (viewers currently see workspace/account spend).

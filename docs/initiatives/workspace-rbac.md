# Initiative: workspace-level RBAC & membership

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Access control today stops at the **account** tier: `AccountRole` (`admin | developer |
product`, combinable — `backend/packages/kernel/src/domain/types.ts`) governs what a member
can do, and account membership implicitly grants visibility into **every workspace** the
account owns. There is no `WorkspaceRole`, no workspace-membership table, and no way to
scope a board to a team — a real adoption blocker for any org where separate teams (or
external contractors) share one account but must not see each other's boards, budgets, or
agent runs.

End state: an optional **workspace membership** layer below the account tier. An account
admin can restrict a workspace to an explicit member list (with per-member workspace roles);
an unrestricted workspace keeps today's behaviour (all account members). Enforcement lives
in ONE place — the shared authz middleware — not scattered per controller.

## Target pattern

1. **Domain + contracts**: `WorkspaceRole` (start minimal: `admin | member | viewer`) and a
   `WorkspaceMember` entity in `@cat-factory/contracts` + kernel `domain/types.ts`, mirroring
   how `AccountRole` is modelled. A workspace gains an `accessMode: 'account' | 'restricted'`
   flag (default `account` — today's behaviour, so the feature is strictly opt-in).
2. **Port + persistence**: a `WorkspaceMemberRepository` kernel port
   (`get`/`listByWorkspace`/`listWorkspacesForUser`/`upsert`/`remove` — batch-shaped reads,
   no per-member point-read loops), implemented in BOTH runtimes (D1 table ⇄ Drizzle
   `db/schema.ts` + generated migration) with a conformance assertion, per "Keep the
   runtimes symmetric".
3. **Enforcement at the seam**: extend the shared workspace-scoping middleware in
   `@cat-factory/server` (where `c.get('container')` + the session principal meet) so every
   `/workspaces/:ws/*` route resolves an effective workspace role once per request. A
   `restricted` workspace with no matching membership ⇒ 404 (not 403 — don't leak
   existence). Controllers consume the resolved role; they do NOT re-derive it.
4. **Role semantics**: `viewer` = read-only board/runs; `member` = today's developer surface
   (create/start/stop tasks); workspace `admin` = settings, merge presets, budgets,
   membership management. Account `admin` always retains implicit access to every
   workspace (the escape hatch — no lock-out state).
5. **Frontend**: workspace membership management UI beside `AccountTeamSettings.vue`
   (member list, role select, restrict toggle), workspace picker filtered by
   `listWorkspacesForUser`, and role-gated affordances (hide/disable, never rely on the
   client for enforcement). All new copy through i18n (`en.json` + all locales in the same
   PR, per the parity gate).

## Prioritized checklist

| # | Slice | Status | PR |
| - | ----- | ------ | -- |
| 1 | Contracts + kernel types (`WorkspaceRole`, `WorkspaceMember`, `accessMode`) | ⬜ todo | |
| 2 | `WorkspaceMemberRepository` port + D1 ⇄ Drizzle impls + conformance assertions | ⬜ todo | |
| 3 | Effective-role resolution in the shared authz middleware (404 on non-membership; account-admin escape hatch) | ⬜ todo | |
| 4 | Role enforcement pass over the workspace-scoped controllers (write surfaces honour `viewer`/`member`/`admin`) | ⬜ todo | |
| 5 | Public-API keys: a key minted for a restricted workspace respects membership of the minting user (coordinate with `public-api-expansion` #13 scopes) | ⬜ todo | |
| 6 | SPA: membership management UI + filtered workspace picker + role-gated affordances (+ i18n, all locales) | ⬜ todo | |
| 7 | Real-time: WS ticket mint (`auth/wsTicket.ts`) verifies workspace access for restricted workspaces | ⬜ todo | |
| 8 | e2e spec: restricted workspace invisible to a non-member (seed via REST, assert live UI) | ⬜ todo | |

## Conventions & gotchas

- **Default-open, opt-in restriction.** `accessMode: 'account'` must behave byte-for-byte
  like today so existing deployments see zero change; no data migration needed (pre-1.0,
  back-compat is a non-goal anyway).
- **One enforcement point.** The middleware resolves the effective role; a controller that
  re-checks membership itself is a smell. Batch the membership read (it runs on every
  request — a cached slice via the `AppCaches` seam, invalidated on membership writes, not
  a hand-rolled Map).
- **404, not 403,** for a workspace the caller can't see — existence is information.
- **Don't forget the side doors**: WS tickets, public API keys, notification `act`
  endpoints, and the retry/agent-runs routes are all workspace-scoped surfaces that must go
  through the same resolution.

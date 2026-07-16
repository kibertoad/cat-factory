# Initiative: account audit log & user-session revocation

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Two related org-adoption/compliance gaps:

- **No audit trail.** Privileged and destructive actions — invitations sent/accepted, role
  changes, budget/policy/preset edits, provider-key changes, workspace/service archival,
  run start/stop/retry, notification `act` (which can perform a real merge) — leave no
  record of *who did what, when*. The only history surfaces are per-run failure/step
  histories. For any org rollout (and any future SOC2-ish story) an account-level audit
  log is table stakes.
- **No user-session revocation.** Sessions are stateless HMAC-signed tokens
  (`server/src/auth/signing.ts`); logout is client-side drop, and a leaked bearer stays
  valid until expiry. "Sign out all devices" / "revoke on role removal" is impossible.
  `backend/docs/auth.md` names revocation as a possible follow-up, and security-hardening
  round 1 item 8 covers *machine*-token revocation — **user sessions are covered by
  neither tracker**.

End state: an append-only `audit_events` store written at the service layer for a defined
catalog of privileged actions, an account-admin viewer UI, and cheap bulk session
revocation via a per-user session-generation check.

## Target pattern

1. **One writer seam, not scattered calls**: an `AuditService` (orchestration/integrations)
   with a single `record(event)` — `{ accountId, workspaceId?, actor (userId | apiKeyRef |
   'system'), action, targetType, targetId, summary, at }`. Services call it at the point
   the mutation **commits** (not in controllers — the service layer is where actor +
   outcome are both known). Best-effort: an audit write failure logs, never fails the
   action.
2. **Event catalog as a contracts union**: `AuditAction` in `@cat-factory/contracts` (the
   wire vocabulary convention), so the SPA maps actions to i18n keys with the exhaustive
   `Record` tier-2 guard. Start with the high-value set: membership/roles, invitations,
   budgets/policies/presets, credentials (metadata only), archival/deletion, run
   start/stop/retry, notification `act`, API-key mint/revoke.
3. **Storage**: append-only `audit_events` table (D1 ⇄ Drizzle + conformance), indexed by
   account + time, paginated reads only (`listByAccount(cursor)`), retention-swept on a
   long window (audit wants years, not days — but pre-1.0, pick a pragmatic default env
   knob). **Payloads are summaries, never secrets** — key *names*, not values; no prompt
   bodies.
4. **Viewer**: an account-admin panel (filter by action class / actor / time; beside
   `AccountTeamSettings.vue`), reading the paginated endpoint.
5. **Session revocation — generation, not blocklist**: add a `sessionGeneration` (int) to
   the user row; mint it into the token claims; auth middleware compares claim vs row.
   "Sign out all devices" / admin revoke = increment the generation — one row write, no
   token blocklist table, no per-request blocklist lookup beyond the user row the request
   resolves anyway. (This is why it beats a revocation list here; coordinate with — don't
   duplicate — security-hardening item 8's machine-token revocation.)

## Prioritized checklist

| # | Slice | Status | PR |
| - | ----- | ------ | -- |
| 1 | `AuditAction` contracts union + kernel port + `audit_events` D1 ⇄ Drizzle + conformance | ⬜ todo | |
| 2 | `AuditService.record` + instrumentation of the membership/role/invitation + budget/policy paths | ⬜ todo | |
| 3 | Instrument run lifecycle (start/stop/retry, notification `act`) + credential/API-key metadata events | ⬜ todo | |
| 4 | Paginated `GET /accounts/:id/audit-events` + admin viewer UI (i18n all locales; action labels via exhaustive Record) | ⬜ todo | |
| 5 | `sessionGeneration` claim + middleware check + "sign out all devices" (self-serve) | ⬜ todo | |
| 6 | Admin-forced revocation on member removal / role downgrade (auto-increment) — audited, naturally | ⬜ todo | |
| 7 | Retention sweep + env knob (both runtimes) | ⬜ todo | |

## Conventions & gotchas

- **Audit at the service layer, after commit** — controller-level logging double-counts
  validation failures; engine-internal steps ('system' actor) go through the same seam.
- **Append-only means append-only**: no update/delete surface on the table besides the
  retention sweep; the viewer is read-only.
- **Never audit secret material** — a credential change event carries provider + key name
  + actor, not the value; agent contexts and prompts are out of scope entirely.
- **Generation check must not add a query**: fold it into the user/principal resolution the
  request already performs; if a route authenticates without touching the user row, that
  route needs a deliberate decision (cheap cached read via the `AppCaches` seam,
  invalidated on generation bump).
- **List reads are paginated from day one** (audit tables grow monotonically — the
  unbounded-SELECT lesson from the perf tracker applies before it hurts).
- Public-API keys are a distinct principal type — represent them as `apiKeyRef` actors, and
  keep their lifecycle events in scope (mint/revoke are among the most audit-worthy
  actions).

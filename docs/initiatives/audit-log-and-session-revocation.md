# Initiative: account audit log & user-session revocation

**Status:** in progress (slices 1 + 2 landed: the store, the write seam, and the tenancy writers) ·
**Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Two related org-adoption/compliance gaps:

- **No audit trail.** Privileged and destructive actions leave no record of _who did what,
  when_: invitations sent/accepted, role changes, budget/policy/preset edits, provider-key
  changes, workspace/service archival, run start/stop/retry, notification `act` (which can
  perform a real merge). The only history surfaces are per-run failure/step
  histories. For any org rollout (and any future SOC2-ish story) an account-level audit
  log is table stakes.
- **No user-session revocation.** Sessions are stateless HMAC-signed tokens
  (`server/src/auth/signing.ts`); logout is client-side drop, and a leaked bearer stays
  valid until expiry. "Sign out all devices" / "revoke on role removal" is impossible.
  `backend/docs/auth.md` names revocation as a possible follow-up, and security-hardening
  round 1 item 8 covers _machine_-token revocation; **user sessions are covered by
  neither tracker**.

  Re-checked 2026-08-04, still true: `sessionGeneration` appears nowhere in the repo, `users`
  carries no such column, and `signing.ts` still states outright that "there is no server-side
  store". What DID land is round-1 item 8 as round-2's **SEC-5** (the `machine_nodes` roster, the
  shared `verifyMachineRequest` gate, `POST /auth/machine-nodes/:nodeId/revoke`), which is the
  MACHINE half and is easy to mistake for this one. Nothing to remove from this tracker; SEC-5 is
  the pattern slices 5–6 should copy.

End state: an append-only `audit_events` store written at the service layer for a defined
catalog of privileged actions, an account-admin viewer UI, and cheap bulk session
revocation via a per-user session-generation check.

## Target pattern

1. **One writer seam, not scattered calls**: an `AuditService` (orchestration/integrations)
   with a single `record(event)`: `{ accountId, workspaceId?, actor (userId | apiKeyRef |
'system'), action, targetType, targetId, summary, at }`. Services call it at the point
   the mutation **commits** (not in controllers; the service layer is where actor +
   outcome are both known). Best-effort: an audit write failure logs, never fails the
   action.
2. **Event catalog as a contracts union**: `AuditAction` in `@cat-factory/contracts` (the
   wire vocabulary convention), so the SPA maps actions to i18n keys with the exhaustive
   `Record` tier-2 guard. Start with the high-value set: membership/roles, invitations,
   budgets/policies/presets, credentials (metadata only), archival/deletion, run
   start/stop/retry, notification `act`, API-key mint/revoke.
3. **Storage**: append-only `audit_events` table (D1 ⇄ Drizzle + conformance), indexed by
   account + time, paginated reads only (`listByAccount(cursor)`), retention-swept on a
   long window (audit wants years, not days, but pre-1.0, pick a pragmatic default env
   knob). **Payloads are summaries, never secrets**: key _names_, not values; no prompt
   bodies.
4. **Viewer**: an account-admin panel (filter by action class / actor / time; beside
   `AccountTeamSettings.vue`), reading the paginated endpoint.
5. **Session revocation via generation, not blocklist**: add a `sessionGeneration` (int) to
   the user row; mint it into the token claims; auth middleware compares claim vs row.
   "Sign out all devices" / admin revoke = increment the generation: one row write, no
   token blocklist table. Copy **SEC-5** (`machine_nodes`): a kernel port, the check folded
   into ONE shared gate rather than per-route, an owner-scoped revoke endpoint, a
   conformance suite, and retention pruning.

   **Correction (2026-08-04): the "no extra query" claim below was wrong, and slice 5 has to
   confront it.** The gotcha said to fold the check into "the user/principal resolution the
   request already performs". There is no such resolution. `requireAuth`
   (`server/src/auth/middleware.ts`) performs ZERO reads: it verifies the HMAC and publishes the
   user straight off the token claims. `loadWorkspaceAccess` reads membership rows, not the user
   row, and only on `/workspaces/:ws/*`. So a generation check is a NEW per-request read on a
   middleware that currently makes none.

   Two pieces of good news. `verifySession` is a single chokepoint (one function plus three
   `AuthController` callers), so the check lands in one place by construction. And
   `caches.workspaceAccess` is the precedent to copy rather than a decision to re-argue: a 60s
   TTL on Node as a freshness backstop with invalidation on the generation bump, and
   `enabled: false` on the Worker, whose stated reason transfers verbatim ("a TTL'd entry would
   keep granting access after a peer isolate revoked a member"). Accept that the Worker resolves
   it live, as it already does for workspace access.

## Prioritized checklist

| #   | Slice                                                                                                                | Status  | PR      |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| 1   | `AuditAction` contracts union + kernel port + `audit_events` D1 ⇄ Drizzle + conformance                              | ✅ done | this PR |
| 2   | `AuditService.record` + instrumentation of the membership/role/invitation + budget/policy paths                      | ✅ done | this PR |
| 3   | Instrument run lifecycle (start/stop/retry, notification `act`) + credential/API-key metadata events                 | ⬜ todo |         |
| 4   | Paginated `GET /accounts/:id/audit-events` + admin viewer UI (i18n all locales; action labels via exhaustive Record) | ⬜ todo |         |
| 5   | `sessionGeneration` claim + middleware check + "sign out all devices" (self-serve)                                   | ⬜ todo |         |
| 6   | Admin-forced revocation on member removal / role downgrade (auto-increment); audited, naturally                      | ⬜ todo |         |
| 7   | Retention sweep + env knob (both runtimes)                                                                           | ⬜ todo |         |

## Conventions & gotchas

- **Audit at the service layer, after commit**: controller-level logging double-counts
  validation failures; engine-internal steps ('system' actor) go through the same seam.
- **Append-only means append-only**: no update/delete surface on the table besides the
  retention sweep; the viewer is read-only.
- **Never audit secret material**: a credential change event carries provider + key name +
  actor, not the value; agent contexts and prompts are out of scope entirely.
- **The generation check DOES add a query** (corrected; the original text claimed otherwise).
  See target pattern 5: nothing on the request path reads the user row today, so slice 5 owes a
  deliberate cached read via the `AppCaches` seam, invalidated on the generation bump, modelled on
  `workspaceAccess`.
- **List reads are paginated from day one** (audit tables grow monotonically; the
  unbounded-SELECT lesson from the perf tracker applies before it hurts).
- Public-API keys are a distinct principal type: represent them as `apiKeyRef` actors, and
  keep their lifecycle events in scope (mint/revoke are among the most audit-worthy
  actions).

## What slices 1–2 settled (carry these forward)

- **The MAIN store, not the telemetry store**, and the reasoning is worth keeping because the
  instinct runs the other way (an append-only log looks telemetry-shaped). Volume is admin
  actions, single digits per account per month, against telemetry's row per LLM CALL. Retention is
  the opposite requirement: `LLM_CALL_METRICS_RETENTION_DAYS` defaults to **3**. And in mothership
  mode the `telemetry` bucket is written AND read on the laptop, which would scatter the trail
  across nodes and leave it readable and deletable by the person it audits. `gate_outcomes` is the
  precedent. **The boundary to watch**: if a later slice wants per-step or per-LLM-call audit
  granularity, that IS a telemetry-shaped sink and belongs in a separate one, not in this table
  grown sideways.
- **`system` is asserted, never defaulted.** Where no acting user resolves, record NOTHING. The one
  path that gets there is `AUTH_DEV_OPEN`, where the whole authorization model is bypassed anyway;
  an unaudited write with auth off is a property of running with auth off, whereas an event blaming
  the engine for a human's action is a defect in the log. `WorkspaceMemberService.actorOf` is the
  single place this is decided.
- **`record` is fire-and-forget and returns `void`.** It must never fail, delay or reorder the
  action it describes. The READ has the OPPOSITE disposition and propagates: an empty page and an
  unreachable store must not look the same to an admin. Nothing in the platform reads an event back
  to decide anything, which is what makes the fire-and-forget safe.
- **`CoreDependencies.auditRecorder` is REQUIRED**, joining `logger` and `operationalMetrics`. An
  un-wired audit log reads as "nobody changed anything", the exact assurance it exists to give.
  `noopAuditRecorder` is the explicit opt-out.
- **The whole surface is mothership-`admin`**, and slice 3 must not casually flip it. Every action
  instrumented so far is an admin-gated mutation whose own repository is already `admin` for the
  stated reason (the machine token scopes ACCOUNTS not ROLES, and the RPC bypasses the
  service-layer `requireAdmin`). `append` carries a second reason: the event names its own ACTOR,
  so a node that could reach `append` could forge entries attributing anything to anyone in its
  account scope. When slice 3 audits a node-driven run, the row must be written by the MOTHERSHIP
  from what it already observes, never accepted from the node's say-so.
- **A supersession is not a revocation.** Re-inviting an address revokes the prior pending row;
  recording that as `invitation_revoked` would make it indistinguishable from an admin withdrawing
  an invitation. The adjacent `invitation_created` event is the explanation. The same discipline
  applies to any future auto-cleanup: an action means a human chose it.
- **Pagination is a keyset on the (at, id) PAIR**, not on `at` alone and never an OFFSET. Two events
  in the same millisecond straddle a page boundary and get served twice or skipped; the conformance
  suite pins exactly that case. The codec lives in kernel (`domain/audit-log.ts`) so the two
  facades cannot drift, because a mismatched cursor looks like nothing at all at the boundary.
- **`action` is a CLOSED vocabulary that is also PERSISTED, so slice 4's viewer owes a runtime
  guard.** Both repositories read the column back with a cast (`row.action as AuditAction`), which
  is the honest "trust the row" read at a store boundary, but it means a RETIRED member still
  exists in the data after it leaves the type. Nothing switches on the value yet. The moment the
  viewer maps actions to copy through an exhaustive `Record`, an old row becomes `undefined`
  spliced into an admin's screen: narrow with a predicate derived from the picklist's own options,
  and render an unrecognised action as itself rather than dropping the row. A dropped row is the
  one failure an audit viewer must never have. Retiring a member is never a rename in place.
- **Slice 7 is still owed and the table is unbounded until it lands.** `deleteOlderThan` was
  deliberately NOT added in slice 1: an unwired repository method is dead surface, and adding it
  means classifying it (`sweeper`) and wiring both facades' retention sweeps, which IS slice 7.

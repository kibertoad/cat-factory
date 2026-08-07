# Initiative: account audit log & user-session revocation

**Status:** in progress (slices 1, 2, 4, 5, 6, 7 landed: the store, the write seam, the tenancy
writers, the admin viewer, session revocation and retention — slice 3's run-lifecycle half is the
only thing left) · **Owner:** core · **Started:** 2026-07-16

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
'system'), action, targetType, targetId, details, at }`. Services call it at the point
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
   knob). **Payloads are safe-to-show fields, never secrets**: key _names_, not values; no
   prompt bodies.
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

| #   | Slice                                                                                                                | Status              | PR      |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------- | ------- |
| 1   | `AuditAction` contracts union + kernel port + `audit_events` D1 ⇄ Drizzle + conformance                              | ✅ done             | this PR |
| 2   | `AuditService.record` + instrumentation of the membership/role/invitation + budget/policy paths                      | ✅ done             | this PR |
| 3   | Instrument run lifecycle (start/stop/retry, notification `act`) + credential/API-key metadata events                 | ⬜ todo (see below) |         |
| 4   | Paginated `GET /accounts/:id/audit-events` + admin viewer UI (i18n all locales; action labels via exhaustive Record) | ✅ done             | this PR |
| 5   | `sessionGeneration` claim + middleware check + "sign out all devices" (self-serve)                                   | ✅ done             | this PR |
| 6   | Admin-forced revocation on offboarding; audited, naturally                                                           | ✅ done             | this PR |
| 7   | Retention sweep + env knob (both runtimes)                                                                           | ✅ done             | this PR |

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
  `workspaceAccess`. The alternative it must be weighed against is short session TTLs plus a bump,
  which adds no read and accepts a bounded revocation window. Either way there is a user-row column
  behind it (D1 migration ⇄ Drizzle), so this is not the one-line middleware change it reads as.
- **SSO is the consumer that makes slice 5 load-bearing.** See
  [`enterprise-sso-oidc.md`](./enterprise-sso-oidc.md): the whole offboarding promise of SSO is
  "we disabled them in the IdP and they lost access", which a stateless session cannot keep on
  its own. The two should land together.
- **List reads are paginated from day one** (audit tables grow monotonically; the
  unbounded-SELECT lesson from the perf tracker applies before it hurts).
- Public-API keys are a distinct principal type: represent them as `apiKeyRef` actors, and
  keep their lifecycle events in scope (mint/revoke are among the most audit-worthy
  actions).

## What slices 1–2 settled (carry these forward)

- **Its OWN store, and NOT the telemetry one.** These are two separate decisions and conflating
  them gets the design wrong in opposite directions.

  _Not telemetry_: the profile is the mirror image. Volume is admin actions, single digits per
  account per month, against telemetry's row per LLM CALL, and retention is the opposite
  requirement (`LLM_CALL_METRICS_RETENTION_DAYS` defaults to **3**). Decisively, the `telemetry`
  mothership bucket is written AND read on the LAPTOP, which would scatter the trail across nodes
  and leave it readable and deletable by the person it audits.

  _But still its own store_ (a required `AUDIT_DB` D1 database; an `audit` Postgres schema on
  Node), for RETENTION rather than write profile. After the run-lifecycle slice this is the only
  table in the platform that grows monotonically with run volume AND wants a multi-year window
  (`token_usage` grows with runs but prunes at ~395 days; the telemetry sinks grow far faster but
  prune at 3), and D1's ceiling is 10 GB PER DATABASE. Measured **~500 B/row** on Postgres (~260
  heap + ~245 index, the index as expensive as the data because the keyset carries `id` as its
  tie-break): 1,000 runs/day ≈ 550 MB/year, 10,000 ≈ 5.5 GB/year. Full arithmetic in
  [`storage-and-retention.md`](../../backend/docs/storage-and-retention.md).

  Two things the split does NOT buy, so nobody relies on them: it does not survive `db:reset`
  (which drops every app-owned schema together on purpose), and it is not sandbox-style
  blast-radius isolation. What it does buy besides capacity is **governance**: audit retention
  cannot be swept by a knob named for something else, because nothing else lives there.

  **The boundary to watch**: if a later slice wants per-step or per-LLM-call audit granularity,
  that IS a telemetry-shaped sink and belongs in its own, not in this table grown sideways.

- **`audit_events` carries a `workspace_id` and must NEVER cascade on board delete.** A board being
  deleted is itself worth having a record of, so a log a later delete can erase is not an audit
  log. The separate schema/database makes both facades' cascade-completeness guards exclude it
  structurally rather than by an entry in a list someone could add to.
- **`system` is asserted, never defaulted.** Where no acting user resolves, record NOTHING. The one
  path that gets there is `AUTH_DEV_OPEN`, where the whole authorization model is bypassed anyway;
  an unaudited write with auth off is a property of running with auth off, whereas an event blaming
  the engine for a human's action is a defect in the log. `WorkspaceMemberService.actorOf` is the
  single place this is decided.
- **`record` never FAILS the action it describes, and is nonetheless AWAITED.** Fire-and-forget was
  the first shape and is wrong on the primary runtime: an un-awaited promise is discarded when a
  Worker isolate freezes after the response (the rule `@cat-factory/server`'s `http/waitUntil.ts`
  states, and the reason `ContainerAgentExecutor` awaits its context snapshot), so the row would
  simply be missing in production while every test driving a fake recorder passed. `runBestEffort`
  keeps the swallow, so an outage still costs the row and never the mutation. Anything a later slice
  records from a durable driver has the same obligation, for the same reason (an isolate hibernating
  on `step.sleep` drops it too). The READ has the OPPOSITE disposition and propagates: an empty page
  and an unreachable store must not look the same to an admin.
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
- **`action` and `targetType` are CLOSED vocabularies that are also PERSISTED**, so the read side
  widens rather than casting. Slice 1 first read both columns back with a bare
  `row.action as AuditAction`, the honest-looking "trust the row" read at a store boundary; what it
  hides is that a member RETIRED from the union goes on existing in rows written before it was, so
  the moment the viewer maps actions to copy through an exhaustive `Record` an old row splices
  `undefined` into an admin's screen. `AuditEventView` therefore types both as
  `| RetiredAuditValue`, and `readAuditAction` / `readAuditTargetType` (predicates DERIVED from the
  picklists' own options) name an unrecognised value as itself. Never guessed onto a current member,
  and above all never dropped: a missing row is the one failure an audit viewer must not have.
  Retiring a member is never a rename in place.
- **A row states VALUES, not prose.** `details` is machine-readable fields the viewer interpolates
  into translated copy, with `AUDIT_ACTION_DETAIL_KEYS` naming each action's slots. Slice 1 first
  wrote an English `summary` sentence, which reads as helpful and is the one modelling mistake here
  that cannot be walked back: the backend does not localize, and a PERSISTED sentence (unlike a wire
  shape) can never be re-rendered for a reader in another locale years later. Anything a later slice
  wants a viewer to say goes in as fields plus a key.
- **A new D1 lineage is four edits, and three of them are outside the runtime.** `audit-migrations/`
  needs its `[[d1_databases]]` entry, its `files` entry in the worker package, a leg in
  `deploy/backend`'s `db:migrate:*` scripts AND a path in deploy.yml's `migrations` change filter.
  Miss either of the last two and slice 7's retention migration is never applied to production: the
  Worker ships against a schema that never moved, which surfaces as a repository error rather than
  as a failed deploy. The production `wrangler.toml` also may not carry a placeholder id in a LIVE
  binding, since deploys are automatic on merge (CI's "Guard deploy placeholders" refuses one).

## What slices 4-7 settled (carry these forward)

- **The generation check is a NEW per-request read, and slice 5 paid for it rather than avoiding
  it.** The correction above was right: nothing on the request path read the user row. The two
  options were a cached read or short TTLs plus a bump; the cached read won, because a bounded
  revocation WINDOW is the one property an offboarding story cannot advertise ("we disabled them
  and they lost access, within the hour" is not the claim). `userSessionGeneration` is modelled on
  `workspaceAccess` down to the isolate-safe pass-through, and the Worker's real per-request D1
  read is the accepted cost, stated here rather than discovered in production.

- **Three refusals, each closing a hole the obvious version leaves.** A token with NO `gen` claim
  is refused, not admitted: absent-means-current would be a permanent bypass and the one an
  attacker aims at, and the cost is one re-login for everybody. A claim ABOVE the row is refused
  too, not only a stale one, because no mint can produce it — a database restored from backup
  would otherwise re-admit every session it had revoked. And a user with NO row is refused, which
  is what ends a deleted user's unexpired bearer; `sessionGeneration` returns `null` rather than
  `0` precisely so those two cannot be flattened.

- **The bump is evaluated IN THE STORE and returns the new value.** `current + 1` computed in the
  repository passes every sequential test and is wrong the moment two admins offboard the same
  person, which is exactly when it is being used. The conformance suite races three bumps and
  asserts the returned values are a permutation of 1..N.

- **Revoke ORDER is store-then-cache, and reversing it is silent.** A concurrent request would
  otherwise re-populate the cache from the pre-bump row and go on admitting the revoked bearer for
  a full TTL. `UserService.revokeSessions` owns both steps, which is why `AccountService` takes it
  as a bound callback rather than reaching for the repository itself.

- **A role DOWNGRADE deliberately does NOT revoke**, despite the original checklist wording. The
  RBAC gate re-reads roles on the next request (through its own cache, invalidated on the write),
  so nothing about a downgrade survives in the token — it carries no roles. Bumping the generation
  would sign a person out of every board because their role on one was adjusted. Revocation
  withdraws AUTHENTICATION; roles withdraw permission, and the two are separate levers on purpose.

- **There is no account-member REMOVAL path in the product**, which is why slice 6 landed as an
  explicit admin action plus the SSO refusal rather than as a hook on a removal. If a removal path
  is ever added, it should call the same `revokeMemberSessions`.

- **The SSO refusal revocation is best-effort and says so in the log.** The refusal has already
  succeeded by then, so a store failure must not turn a correct denial into a 500 that reads as a
  broken SSO configuration. `sessionsRevoked` on the `sso.refused` line separates "refused them and
  cut their sessions" from "refused them and they still hold a live bearer" — different security
  outcomes, and only the first is the offboarding this feature claims.

- **Self-serve "sign out everywhere" is deliberately NOT audited.** The account audit log records
  what an account ADMIN is answerable for; a person acting on their own sessions belongs to no
  account in particular (they may be in several, or only their own), and filing it under a guess is
  the misattribution the actor model exists to prevent.

- **The viewer resolves names at RENDER time, in one batched read.** Rows store ids because names
  change and a row must go on meaning what it meant; an admin reading `usr_01j…` learns nothing.
  One `listByIds` per page, never a lookup per row. An unresolved name stays `null` and the id is
  rendered, which is the honest answer for the case the log most needs to survive: the person is
  gone, and their having been here is what the row records.

- **A failed READ renders differently from an empty log**, in the store, the controller and the
  component alike. An audit viewer that shows an outage as "nothing happened" tells an admin the
  exact opposite of the truth.

- **Retention got its OWN knob (`AUDIT_EVENT_RETENTION_DAYS`, default 730 days)**, which is the
  governance half of the separate store: audit retention cannot be shortened as a side effect of
  tuning a telemetry window, because nothing else lives behind that name. `deleteOlderThan` takes
  a cutoff and NOTHING else — no account, actor or action predicate — so the sweep can never be
  used to remove the record of one inconvenient thing. The boundary is strict (`at < cutoff`), and
  conformance pins it: an off-by-one there silently shortens every deployment's window.

## What slice 3 still owes, and the problem it has to solve first

The credential/API-key half is ordinary instrumentation. The RUN-LIFECYCLE half is not, and the
reason is the mothership rule already recorded above: `auditEventRepository.append` is `admin`, so
a node cannot write audit rows, and a run started on a mothership-mode node is started by the
ENGINE running there. Instrumenting `RunLifecycleController` would therefore audit run starts on
every hosted deployment and silently record nothing on the one deployment shape where the engine
runs beside no database.

Three things are settled, so the next iteration does not re-argue them:

- **Do not proxy `append`.** The event names its own ACTOR, so a role-blind machine token that
  could reach it could attribute any action to any user in its account scope.
- **Do not fall back to a `system` actor for a node-driven run.** A human started it, and an event
  blaming the engine for a human's action is a defect in the log rather than a gap in it.
- **The mothership's only observation of a node's run is `executionRepository.insertLive`**, whose
  payload already carries `initiatedByUserId` (the platform trusts it for merge policy, ADR 0037).
  Deriving the audit row mothership-side from that write is the shape most likely to be right, and
  it is a persistence-layer side effect that needs designing rather than adding.

Until that lands, run lifecycle is unaudited on every runtime — not just mothership mode — because
landing it only where it happens to work is exactly the facade-parity gap the repo bans.

- **Slice 7's `deleteOlderThan` is now wired** (classified `sweeper`, both facades' retention
  passes, both configs). The note it replaces read: `deleteOlderThan` was deliberately NOT added in
  slice 1, because an unwired repository method is dead surface.

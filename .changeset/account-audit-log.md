---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
---

Account audit log, slices 1 and 2: privileged tenancy actions are now recorded, with the store and the
first real writers landing together.

Until now nothing left a record of who did what: role changes, budget edits, invitations sent and
revoked, board roster changes and access-mode flips all happened with the resulting STATE as the only
evidence. `audit_events` (D1 ⇄ Drizzle, cross-runtime conformance) is an append-only log of them,
written at the point each mutation commits, and the tenancy services in `@cat-factory/workspaces` are
the first writers: account member add / role change, account budget and settings edits, invitation
create / revoke / accept, and the workspace roster's add / role change / remove / access-mode flip.

Three decisions worth knowing, because each has a wrong-looking alternative that reads as correct:

**It is in the MAIN store, not the telemetry store.** An audit log looks append-heavy and therefore
telemetry-shaped, but the volume is admin actions (single digits per account per month, against
telemetry's row-per-LLM-call) and the retention requirement is the opposite: `llm_call_metrics` is
pruned to three days by default. Two other things would break outright. In mothership mode the
`telemetry` bucket is written AND read on the laptop, which would scatter the trail across nodes and
leave it readable and deletable by the person it audits; and the viewer reads by account, which the
main store already scopes through the same `workspaces` sub-select every other rollup uses.
`gate_outcomes` is the precedent followed here.

**The actor is a discriminated principal, and `system` is asserted rather than defaulted.** `user`,
`apiKey` and `system` are three kinds, not a nullable user id, because "the engine did it" and "we
lost track of who did it" are different facts and a log rendering them identically misattributes a
human action to automation. Where no acting user resolves (only reachable under `AUTH_DEV_OPEN`, where
the whole authorization model is bypassed) NOTHING is recorded rather than an event blaming the engine.
`apiKey` is separate from the user who minted the key, so a leaked key is not indistinguishable from
that person in the log.

**`record` cannot fail, delay or reorder the action it describes.** `AuditRecorder.record` returns
`void` and the append runs behind `runBestEffort`, so a store outage costs the audit row and logs a
warning, never the membership change the operator asked for. The READ has the opposite disposition and
propagates: a viewer silently rendering an empty page when the store is down tells an admin the exact
opposite of the truth.

`CoreDependencies.auditRecorder` is REQUIRED, joining `logger` and `operationalMetrics` for the same
reason and with the sharpest version of it: an un-wired audit log reads as "nobody changed anything",
which is precisely the assurance it exists to give. A deployment that does not persist audit events
passes kernel's `noopAuditRecorder`, which says so in code.

INTERNAL BREAK: `WorkspaceMemberService.setRole`, `.remove` and `.setAccessMode` each take a trailing
`actingUserId: string | null`, matching `.add`'s existing shape. Without it those three writes had no
actor to attribute, and defaulting them to `system` would have been the misattribution above.
`@cat-factory/server`'s controller supplies `c.get('user')?.id ?? null`.

Still to come on this initiative: the paginated read endpoint and the admin viewer UI, run-lifecycle
and API-key events, session revocation, and the retention sweep (so the table is unbounded until that
slice lands).

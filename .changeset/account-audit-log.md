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

**It gets its OWN store, and not for the reason telemetry has one.** An audit log looks append-heavy
and therefore telemetry-shaped, but it is the mirror image: low-volume (admin actions, single digits
per account per month, against telemetry's row-per-LLM-call) and long-retention where telemetry
prunes at three days. What makes it a storage question is the run-lifecycle slice, after which this
becomes the only table in the platform that grows monotonically with run volume AND wants a
multi-year window; on a store with a hard 10 GB per-database ceiling that would put a years-deep
trail in competition with live transactional state. Measured at ~508 B/row on Postgres (the index
costing as much as the data, since the keyset carries `id` as its tie-break), so 1,000 runs/day is
~550 MB/year. It is a required `AUDIT_DB` D1 database on Cloudflare and an `audit` Postgres schema on
Node. It is emphatically NOT in the telemetry store: that bucket is written and read on the LAPTOP in
mothership mode, which would scatter the trail across nodes and leave it readable and deletable by
the person it audits.

**OPERATOR ACTION on Cloudflare**: `AUDIT_DB` is required, so a deployment must provision it before
its next deploy (`wrangler d1 create cat_factory_audit`, then paste the id into `wrangler.toml` and
apply `audit-migrations`). Until it is bound the readiness probe reports
`audit: AUDIT_DB is not bound` and privileged actions go unrecorded; requests themselves still
succeed, because the audit write is best-effort by design. Per-PR preview environments provision and
tear it down automatically.

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

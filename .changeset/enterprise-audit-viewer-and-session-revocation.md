---
'@cat-factory/caching': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Make the audit log readable, and make revoking a session actually end it

**Breaking for existing sessions: everyone signs in again once after this deploys.** A session
token now carries a `gen` claim, and one that carries none is refused rather than admitted. That is
the deliberate choice: treating an absent claim as "current" would be a permanent bypass of the
whole revocation mechanism, and it is the hole an attacker would aim at. The cost is a single
re-login; the alternative is a dual-read path that never goes away. Internal wire shape, pre-1.0,
per the repo's compatibility policy.

Two enterprise loose ends, and they are the same story from both ends.

The audit log has been WRITE-ONLY in the product since it landed. Privileged actions were recorded
faithfully and there was no way to read them back: no route, no viewer, and no retention, so the
one table designed to be kept for years was also the one growing without a bound. It now serves a
keyset-paginated page to account admins and renders in an admin panel, as translated sentences
composed from the row's machine-readable fields rather than from stored prose — which is what lets
a row written today read correctly for somebody in another language years later, and what makes an
action this build no longer declares render as "unrecognised" instead of splicing `undefined` into
an operator's screen. Names are resolved at render time in one batched read per page, and a name
that no longer resolves stays null so the id shows: the person being gone is exactly the thing the
row is kept to record. A failed READ is rendered differently from an empty log at every layer,
because an audit viewer that reports an outage as "nothing happened" tells an admin the reverse of
the truth. Retention arrives with its own knob (`AUDIT_EVENT_RETENTION_DAYS`, default 730 days),
which is the governance half of keeping the log in its own store: it cannot be shortened as a side
effect of tuning a telemetry window, and the prune takes a cutoff and nothing else, so it can never
be used to remove the record of one inconvenient thing.

The other end is enterprise SSO, whose whole offboarding promise is "we disabled them in the
identity provider and they lost access". A stateless signed session could not deliver that: group
membership was already re-read on every sign-in, so a removed person could not get a NEW session,
but the one they were already holding stayed valid until it expired. Each user row now carries a
session generation that every token is stamped with, so ending every session a person holds is one
write with nothing to enumerate. An SSO sign-in the directory refuses now cuts their live sessions
as well as withholding a new one; an admin can do the same for a member who has left or lost a
laptop (recorded in the audit log, naturally); and anyone can sign themselves out everywhere.

Two decisions worth knowing. A role change deliberately does NOT revoke: the RBAC gate re-reads
roles on the next request and the token carries none, so coupling them would sign a person out of
every board because their role on one was adjusted. And the check is a NEW read on a path that
previously touched no store at all — served through the app cache with invalidation on every bump,
which means the Worker (whose isolates share no invalidation bus, so the entry passes through
there) pays a real per-request read. That is accepted rather than discovered: a cache with a TTL
would go on admitting a bearer a peer isolate had already revoked, and "they lost access, within
the minute" is not the claim an offboarding story can make.

Still open, and stated so nobody assumes otherwise: run start/stop/retry are not yet audited. That
half needs the mothership to derive the row from what it observes rather than accept it from a
node's say-so, since a node cannot be allowed to write events that name their own actor — the
design question is written up in `docs/initiatives/audit-log-and-session-revocation.md`.

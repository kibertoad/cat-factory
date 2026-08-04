---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/observability-otel': minor
'@cat-factory/app': minor
---

Security hardening round 2, P1: close SEC-3, SEC-4 and SEC-5 (docs/initiatives/security-hardening-round-2.md).

- **Machine tokens are revocable (SEC-5).** Every `POST /auth/machine-token` mint is recorded on
  the new `machine_nodes` roster (kernel `MachineNodeRepository`; D1 migration
  `0077_machine_nodes.sql` ⇄ Drizzle `machineNodes`), the new shared machine gate
  (`verifyMachineRequest`) checks the revocation tombstone on every `/internal/*` machine surface
  plus the WS subscribe handshake, and the owner drives `GET /auth/machine-nodes` /
  `POST /auth/machine-nodes/:nodeId/revoke`. A revoked node id can never be re-minted and a
  foreign node id cannot be taken over, enforced by the roster WRITE itself (a guarded
  `ON CONFLICT ... WHERE`) so two concurrent mints of one id cannot leave a row whose owner did
  not mint it. A mothership with no roster wired refuses to mint at all, since an unrecorded token
  could never be revoked; a roster read that fails refuses the call rather than serving it, and on
  the WS handshake answers 503 (retry) rather than crashing the upgrade. Rows prune once past
  their latest signed `exp`.
- **The password throttle is durable and spoof-resistant (SEC-4).** Attempts land in the new
  cross-replica `auth_attempts` ledger (kernel `AuthAttemptRepository`; D1 migration
  `0078_auth_attempts.sql` ⇄ Drizzle `authAttempts`) with a per-`ip:email` burst cap AND a per-IP
  aggregate that catches one-password-many-emails credential stuffing; the in-process Map remains
  only as the store-outage backstop. WHICH header carries the client address is a per-facade
  decision behind `ServerContainer.resolveClientAddress`: Node reads the socket peer, and
  `x-forwarded-for` (rightmost hop, `AUTH_TRUST_PROXY_HOPS` deep) only under the new
  `AUTH_TRUST_PROXY=true`; the Worker reads `cf-connecting-ip`, which is authentic only there.
  Addresses are normalised before keying (port stripped, non-IP refused, IPv6 bucketed to its
  /64). The 429 carries `details.reason: 'auth_attempts'` and `retryAfterSeconds`, and both a trip
  and a store outage are counted (`auth.throttle.limited`, `auth.throttle.store_unavailable`).
  Completes the durable-auth-rate-limiting initiative, now ADR 0032.
- **Local-runner hosts are loopback-only by default (SEC-3). BEHAVIOUR BREAK:** registering or
  calling a locally-run model endpoint on a private-LAN host (RFC1918 / ULA / mDNS `.local`) now
  requires the operator opt-in `LOCAL_MODELS_ALLOW_LAN=true` on hosted deployments; single-tenant
  local mode defaults the opt-in on. The policy binds the write boundary, the test probe and every
  run-time redirect hop, so an existing LAN row on a hosted deployment is refused instead of
  silently serving an internal-network SSRF surface. Such a row is now also reported on the
  endpoint itself (`LocalModelEndpoint.urlBlockedReason`) and its models are withheld from the
  picker, so the failure surfaces in settings rather than mid-run.
- **BEHAVIOUR BREAK (SEC-3):** a runner base URL may no longer carry a query string, a `#`
  fragment or `.`/`..` path segments, and `*.localhost` subdomains are no longer accepted (plain
  `localhost` still is). A base URL ending in `#` made the fixed `/models` and `/chat/completions`
  suffixes inert, which turned both server-side forwards into an arbitrary-path request against
  whatever listens on loopback; endpoint URLs are now composed through one validating helper
  rather than concatenated. Every refusal carries a machine-readable
  `LocalRunnerUrlReason` the SPA maps to translated copy.

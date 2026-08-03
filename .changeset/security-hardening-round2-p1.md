---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
---

Security hardening round 2, P1: close SEC-3, SEC-4 and SEC-5 (docs/initiatives/security-hardening-round-2.md).

- **Machine tokens are revocable (SEC-5).** Every `POST /auth/machine-token` mint is recorded on
  the new `machine_nodes` roster (kernel `MachineNodeRepository`; D1 migration
  `0077_machine_nodes.sql` ⇄ Drizzle `machineNodes`), the new shared machine gate
  (`verifyMachineRequest`) checks the revocation tombstone on every `/internal/*` machine surface
  plus the WS subscribe handshake, and the owner drives `GET /auth/machine-nodes` /
  `POST /auth/machine-nodes/:nodeId/revoke`. A revoked node id can never be re-minted and a
  foreign node id cannot be taken over. Rows prune once past their latest signed `exp`.
- **The password throttle is durable and spoof-resistant (SEC-4).** Attempts land in the new
  cross-replica `auth_attempts` ledger (kernel `AuthAttemptRepository`; D1 migration
  `0078_auth_attempts.sql` ⇄ Drizzle `authAttempts`) with a per-`ip:email` burst cap AND a per-IP
  aggregate that catches one-password-many-emails credential stuffing; the in-process Map remains
  only as the store-outage backstop. The client IP comes from the socket peer on Node unless the
  new `AUTH_TRUST_PROXY=true` says a trusted proxy overwrites the forwarded headers (the Worker
  keeps trusting the edge-injected `cf-connecting-ip`). The 429 now carries
  `details.reason: 'auth_attempts'` and `retryAfterSeconds`.
- **Local-runner hosts are loopback-only by default (SEC-3). BEHAVIOUR BREAK:** registering or
  calling a locally-run model endpoint on a private-LAN host (RFC1918 / ULA / mDNS `.local`) now
  requires the operator opt-in `LOCAL_MODELS_ALLOW_LAN=true` on hosted deployments; single-tenant
  local mode defaults the opt-in on. The policy binds the write boundary, the test probe and every
  run-time redirect hop, so an existing LAN row on a hosted deployment is refused loudly at fetch
  time (the error names the opt-in) instead of silently serving an internal-network SSRF surface.

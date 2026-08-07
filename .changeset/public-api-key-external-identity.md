---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Let a headless provisioner say who a key acts for, and carry that onto the runs the key starts

`POST /api/v1/keys` accepts an optional `externalIdentity`: an opaque string naming who, on the
CALLER's side, the key acts for. An integration that mints one key per person (the Cloudflare OS
gatekeeper of `docs/initiatives/cloudflare-os-gatekeeper.md` is the motivating consumer) could
already get real per-user attribution, but only by keeping its own keyId-to-person table and
joining it against every run it read. The field removes that table: the identity is echoed on the
key resource, on `GET /api/v1/me`, and on both run projections (`publicRun`, `publicJob`) as the
identity the run was started for.

It is opaque in the strongest sense: stored verbatim, never parsed, never resolved against a user,
never an authorization input. What a key may do is still its `scope`; what a run may do is still
its pinned role and mode. Bounded at 200 characters and refused if it carries control characters,
because it is echoed onto surfaces that later render it.

The run's copy is PINNED at admission rather than resolved from the key on read, which is the
decision worth reviewing. Revoking a per-user key is exactly what an integration does when someone
leaves, and that must not erase who a finished run was for; pinning also keeps a page of runs from
becoming a page of credential reads, and matches what the run already does with `initiatedByRole`
and `mode`. It rides `agent_runs.detail` through the shared mappers, so a retry carries it forward
(same work, same requester, whoever pressed retry) and the conformance case asserts it survives
both the store round-trip and the key's revocation on each facade.

Two smaller calls: the identity is never inherited from the provisioning key, since a provisioner
mints for many identities and naming itself would attribute every run to the integration; and the
field is offered on the headless mint only, because the session-authed create already records
`createdByUserId`, an account the platform can resolve.

Additive on the public surface: one optional request field, one nullable field on four
projections, `null` being the correct answer for every key and run that predates it. New nullable
`external_identity` column on both stores (D1 0086, Drizzle). OpenAPI `info.version` goes to
1.29.0.

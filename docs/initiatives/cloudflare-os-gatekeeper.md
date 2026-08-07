# Cloudflare OS Gatekeeper integration

Status: in progress. Slice 1 landed with this tracker; slices 2 to 4 are open.

## Goal and rationale

Cloudflare OS (announced 2026-08-04, `cloudflare/cloudflare-os`) is an open-source enterprise
agent workspace. Its integration pattern is the **Gatekeeper**: a dedicated Worker that holds the
credentials for one external service, exposes typed capability bindings to workspace agents over
Cap'n Web, enforces per-agent method allow-lists and field masking, and mediates human approvals.
Agents never see a raw credential; they hold an object-capability whose methods are exactly what
policy granted.

cat-factory should be consumable as such a service: a workspace agent files a task, starts a run,
watches it, and answers its parked decisions, with the OS's governance around every call. The
benefits accrue at the organizational boundary (credential custody, non-engineer access through
reusable operations, approvals landing in the workspace inbox, one governance pane); the
engineering core loop is untouched.

**Governing principle: the integration is a CONSUMER of the stable public surface, not a fifth
runtime facade.** The Gatekeeper Worker itself lives outside this repo and rides only `/api/v1`
plus the outbound webhook delivery contract. A deployment that never heard of Cloudflare OS is
byte-for-byte unchanged. What lands in core is only what must not drift from the surface it
describes, following the `sdk/mcp` precedent: a generated projection, so the operation table the
Gatekeeper enforces policy with cannot disagree with the API it fronts.

## Architecture (the part that stays external)

One Gatekeeper Worker per (OS deployment ⇄ cat-factory deployment) pairing:

- **Bindings**: typed methods over `@cat-factory/sdk`, grouped exactly as the SDK mounts them
  (`tasks.create`, `decisions.approveStep`, ...). The policy metadata per operation (minimum key
  scope, read vs mutate, stream/binary transport) comes from `@cat-factory/gatekeeper-bindings`
  (slice 1), never hand-curated.
- **Credentials**: cat-factory API keys as Worker secrets, one per paired workspace, minted at
  the narrowest scope the granted binding tier needs. Per-OS-user keys are provisioned through
  `POST /api/v1/keys` so attribution and role-scoped merge policy stay real (ADR 0037/0039).
- **Push**: the Gatekeeper registers its endpoint as the workspace outbound webhook, verifies the
  HMAC, dedupes on `<runId>:<event>`, and fans events into workspace status Gadgets. The webhook
  is a trigger; the API is the truth.
- **Approvals**: parked-decision events surface as OS approval cards; answers post to
  `/api/v1/runs/:runId/decisions/*` with a `decide` key.

## Slices

### 1. Scope as data + `@cat-factory/gatekeeper-bindings` (this PR)

The one piece that must live in core. Three moves, in dependency order:

- **`minScope` on every `/api/v1` route contract** (`withMinScope` in
  `backend/packages/contracts/src/routes/_shared.ts`). The controllers reference
  `contract.minScope` instead of a per-route literal, so the declared scope and the enforced
  scope are one value. Exception: the parked-decision mutations all gate through the one
  `gateDecisionAction` helper, which keeps its `'decide'` literal; the relation "every decision
  mutation contract declares `decide`" is pinned by `routes/public-api-scope.test.ts` instead.
- **`x-min-scope` in the OpenAPI document.** `generate-openapi.mjs` fails on a public contract
  with no `minScope` and stamps it per operation; the three hand-documented raw routes (two SSE
  streams, the artifact blob) carry `'read'` literals beside their hand-written docs. The IR
  (`scripts/sdk/ir.mjs`) requires it on every operation.
- **A sixth emitter** (`scripts/sdk/emit-gatekeeper.mjs`) renders `sdk/gatekeeper/`
  (`@cat-factory/gatekeeper-bindings`): one entry per operation carrying group/method (the SDK's
  own vocabulary), `minScope`, transport kind, consequence hints (shared with the MCP table), the
  path parameter names, and an `invoke` thunk over `@cat-factory/sdk` using the MCP facade's
  flattened-argument convention, so the two projections agree. Hand-written beside it: the scope
  ladder helpers (`scopeSatisfies`, `bindingsWithinScope`). Rides `pnpm gen:sdk` / `check:sdk`
  like every other projection.

### 2. Multiple named outbound webhooks

`/api/v1/notification-webhook` is one endpoint per workspace, so a Gatekeeper cannot enroll
without stealing the slot from an existing integration. Additive change: a
`/api/v1/notification-webhooks` COLLECTION beside the singular resource (which keeps working as
the default entry), OpenAPI minor bump, mirrored persistence D1 ⇄ Drizzle with a conformance
assertion, delivery fan-out over the one `signedDelivery.ts` core, `surface.mjs` entries.
Per-endpoint secrets and event filters; the singular routes project onto the default entry so no
existing consumer moves.

### 3. Key provisioning metadata

An opaque `externalIdentity` on `POST /api/v1/keys`, echoed on the key resource and on run
detail, so an OS deployment can map a run back to the person whose per-user key started it
without keeping its own keyId table. Additive field, both runtimes' key rows, changeset.

**Rejected: an `onBehalfOf` label on the start endpoints.** Attribution by assertion with no
enforcement behind it; per-user keys already give the real thing. Do not re-propose.

**Rejected: a narrower `decide:own` scope rung, for now.** The Gatekeeper can enforce
"answer only runs the OS started" itself by filtering to runs it tracks. If it ever lands in
core it must be a new additive rung, never a narrowing of `decide`.

### 4. External Gatekeeper reference implementation

A separate repository (or an `examples/` deployment repo, decided when Cloudflare OS's partner
packaging settles): the Worker skeleton consuming `@cat-factory/gatekeeper-bindings`, webhook
receiver + Durable Object fan-out, approval-card flow, per-user key minting. Out of scope for
this repo's CI; the bindings package is its contract.

## Checklist

- [x] Slice 1: scope as data, `x-min-scope`, `@cat-factory/gatekeeper-bindings` (this PR)
- [ ] Slice 2: outbound webhook collection (both runtimes + conformance + SDK surface)
- [ ] Slice 3: `externalIdentity` on key provisioning, echoed on run detail
- [ ] Slice 4: reference Gatekeeper Worker (external)

## Gotchas the pilot surfaced

- **`minScope` is the STATIC floor, not the whole admission story.** `startPublicTask` and
  `createPublicJob` escalate to `decide` at request time when the named pipeline can park
  (`pipeline_requires_decide_scope`), and two park shapes slip past even that (see
  `public-api.md`, "Pick the right scope"). The bindings state the floor; a Gatekeeper deciding
  approval tiers should treat run-starting operations as potentially `decide`.
- **Three operations have no contract** (the two SSE streams and the artifact blob). Their
  scope rides a literal in `generate-openapi.mjs` beside their hand-written spec entries, and
  their handlers keep `authorize(c, 'read')` literals. A fourth raw route would join that list;
  prefer a contract if the shape allows one.
- **The scope ladder itself** (`read` < `write` < `decide` < `admin`) is restated in
  `emit-gatekeeper.mjs` (and emitted into the published table), because a published SDK package
  sees the spec alone and OpenAPI's bearer scheme has no scope slot. The emitter refuses an
  operation declaring a rung its ladder lacks, so a rung added to the contracts'
  `PUBLIC_API_SCOPES` fails generation until the emitter (and with it the published helpers)
  moves in the same diff.
- **`contract.minScope` is enforcement, not just documentation**, wherever a controller
  references it. Lowering an annotation lowers the gate. Treat a `minScope` diff in review
  exactly like a permission change, because it is one.

# Cloudflare OS Gatekeeper integration

Status: in progress. Slices 1 and 2 have landed; slices 3 and 4 are open.

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
runtime facade.** The Gatekeeper Worker rides only `/api/v1` plus the outbound webhook delivery
contract, and a deployment that never heard of Cloudflare OS is byte-for-byte unchanged. What
lands in the CORE packages is only what must not drift from the surface it describes, following
the `sdk/mcp` precedent: a generated projection, so the operation table the Gatekeeper enforces
policy with cannot disagree with the API it fronts.

**The Worker itself lives in this repo, as an isolated and separately gated package** under
`deploy/gatekeeper` (slice 4), beside the other example deployments. What makes it a consumer is
not which repository holds it but what it may reach: it depends on `@cat-factory/sdk` and
`@cat-factory/gatekeeper-bindings` as an outside integrator would, nothing in core may import it,
and its CI is its own `paths-filter` lane so it can neither gate nor be gated by the backend
suites. A separate repository was the first plan and buys none of that: the isolation is the
dependency direction and the lane, both of which a workspace states more precisely than a repo
boundary does. Keeping it here is what makes the reference implementation testable against the
same spec that generated its bindings, in the same commit that changes either.

## Architecture (the part that stays outside core)

One Gatekeeper Worker per (OS deployment ⇄ cat-factory deployment) pairing. Everything below is a
`/api/v1` consumer: no kernel port, no facade wiring, no core package that knows it exists.

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
- **`x-min-scope` in the OpenAPI document, plus the `x-public-api-scopes` ladder it is drawn
  from.** `generate-openapi.mjs` fails on a public contract with no `minScope` and stamps it per
  operation; the three hand-documented raw routes (two SSE streams, the artifact blob) carry
  `'read'` literals beside their hand-written docs. The ladder is stamped once at the document
  root from `PUBLIC_API_SCOPES`, because a per-operation floor is unusable without the ranking
  and OpenAPI's bearer scheme has no scope slot. The IR (`scripts/sdk/ir.mjs`) requires both.
- **A sixth emitter** (`scripts/sdk/emit-gatekeeper.mjs`) renders `sdk/gatekeeper/`
  (`@cat-factory/gatekeeper-bindings`): one entry per operation carrying group/method (the SDK's
  own vocabulary), `minScope`, transport kind, consequence hints (shared with the MCP table), the
  path parameter names, and an `invoke` thunk over `@cat-factory/sdk` using the MCP facade's
  flattened-argument convention, so the two projections agree. Hand-written beside it: the scope
  ladder helpers (`scopeSatisfies`, `bindingsWithinScope`) and `resolveConsequence`, which applies
  the cautious default the table's own annotation documents (unannotated mutation = destructive)
  so each consumer does not re-derive it and get it backwards. Rides `pnpm gen:sdk` /
  `check:sdk` like every other projection.

### 2. Multiple named outbound webhooks (landed)

`/api/v1/notification-webhook` was one endpoint per workspace, so a Gatekeeper could not enroll
without stealing the slot from an existing integration. Shipped as an additive
`/api/v1/notification-webhooks` COLLECTION beside the singular resource, which keeps working and
projects onto the reserved id `default`: per-endpoint secrets and filters, `notification_webhooks`
re-keyed to `(workspace_id, id)` on both stores, delivery fan-out over the one `signedDelivery.ts`
core, OpenAPI 1.25.0, four new `surface.mjs` entries in all four SDKs plus the MCP and gatekeeper
projections.

Three decisions worth carrying forward:

- **The id is CALLER-CHOSEN, so `PUT` is idempotent by it.** A Gatekeeper Worker booting cold
  writes its own well-known id and is enrolled, whether or not it has ever run, with no id table of
  its own and no create-or-discover round trip it might be racing a second instance on. A
  server-minted id would have forced exactly that state back onto the consumer this slice exists
  for.
- **Fan-out is CONCURRENT and per-endpoint isolated.** The caller awaits it on the run's terminal
  path, so serial delivery would multiply the wall-clock budget by the endpoint count and make
  enrolling a second integration a latency cost on every run. Isolation is the other half: a
  rejected `Promise.all` would report one failure for the batch, so a permanently broken endpoint
  would mask every sibling's health.
- **`deliveryId` gained no endpoint segment.** Each receiver sees only its own copy, so an
  endpoint-scoped key would put a value in the dedupe key no receiver can act on, and would break
  the one case where two subscriptions correctly collapse (the same URL registered twice).

The cap is 10 per workspace (`webhook_limit_reached`, 409), and it bounds only what CREATES an
endpoint: a workspace at the cap can still disable and delete, which are the actions that resolve
it. It is enforced by the STORE, inside `put`, which takes the limit as an argument and admits or
refuses under it atomically. Counting in the service and writing a statement later would not hold
against the access pattern this whole slice exists for: two instances of a cold-booting Worker
enrolling at once would both see room and both take it, and neither engine makes that safe by
itself (Postgres takes no predicate lock on a row that does not exist, and SQLite serializes each
statement rather than a read-then-write pair). D1 gets it from one conditional upsert; Postgres
needs a transaction-scoped advisory lock per workspace. The conformance suite races ten creates for
four slots, which is the only shape that can see the difference.

### 3. Key provisioning metadata

An opaque `externalIdentity` on `POST /api/v1/keys`, echoed on the key resource and on run
detail, so an OS deployment can map a run back to the person whose per-user key started it
without keeping its own keyId table. Additive field, both runtimes' key rows, changeset.

**Rejected: an `onBehalfOf` label on the start endpoints.** Attribution by assertion with no
enforcement behind it; per-user keys already give the real thing. Do not re-propose.

**Rejected: a narrower `decide:own` scope rung, for now.** The Gatekeeper can enforce
"answer only runs the OS started" itself by filtering to runs it tracks. If it ever lands in
core it must be a new additive rung, never a narrowing of `decide`.

### 4. Gatekeeper reference implementation (`deploy/gatekeeper`)

The Worker skeleton consuming `@cat-factory/gatekeeper-bindings`: Cap'n Web bindings over the
policy table, the webhook receiver plus Durable Object fan-out, the approval-card flow, per-user
key minting. An example deployment template like its neighbours (`deploy/backend`,
`deploy/frontend`): an operator copies it, points it at their own workspace and edits the policy.

Three constraints make "in the repo" and "isolated" both true, and they are the reviewable part:

- **Dependency direction, enforced by the workspace.** It depends on the published surface
  (`@cat-factory/sdk`, `@cat-factory/gatekeeper-bindings`) and nothing in `backend/packages` may
  depend on it. `knip` and `sherif` already see the workspace, so an import in the wrong direction
  is a CI failure rather than a convention.
- **Its own CI lane.** A `gatekeeper` `paths-filter` output gating a job of its own, the shape
  `eks` already has. It must not join the aggregated `Test` gate while the Cloudflare OS protocol
  is still moving: a partner-side breaking change should not turn this repo's CI red.
- **Not a published package.** `private: true`, no changeset, no npm release. It is read and
  copied, not installed.

#### How it gets tested (decided in slice 2, before the Worker exists)

The obvious ambition is a FULL end-to-end: boot a real Cloudflare OS, point it at a real
cat-factory, drive a workspace agent, watch a run settle. It is worth stating plainly why that is
not the plan, because the shape of the answer decides what slice 4 has to build.

**Cloudflare OS cannot be containerized for this.** It ships no image and no compose file; the
local story is `pnpm run-local`, which is `wrangler` driving `workerd` with state in a `.wrangler`
directory, and the self-hosted-on-`workerd` path is documented as incomplete. So "spin one up in
Docker" resolves to "clone a fast-moving partner repo into CI, install its workspace, boot its
runtime", which is not hermetic, is not pinned to anything this repo controls, and would turn a
partner-side change into a red build here. That is the same failure the slice's own CI constraint
already forbids.

**And it would not test the interesting half anyway.** What a full-stack run exercises is mostly
the OS: its agent loop, its Gadgets, its model calls. What can actually be WRONG on our side of the
boundary is the Gatekeeper: which bindings it exposes for a given policy, whether it refuses a call
above the caller's tier, whether it verifies the delivery HMAC, whether it dedupes on `deliveryId`,
whether an approval answer reaches the right decision route. None of that needs an OS to observe.

So the target is a **real-workerd, real-backend, faked-OS** suite, which is hermetic and pins
everything we own:

- The Gatekeeper runs in actual `workerd` under `@cloudflare/vitest-pool-workers`, the harness
  `test-worker` already uses. Not a Node mock of a Worker: the credential-custody story IS "the key
  is a Worker secret", so a test that never binds one proves nothing about it.
- The backend on the other side is the REAL Node facade, booted the way
  `backend/internal/sdk-smoketest` boots it (`@cat-factory/e2e`'s `testServer.ts`, real Postgres,
  only the LLM/agent side faked). Reusing that boot rather than composing a second wiring is the
  same reasoning the smoketest gives: a bespoke composition would prove the Gatekeeper works
  against _that_.
- The OS side is a **Cap'n Web client** in the test, not an OS. It is the OS's own protocol, so the
  contract under test is real; what is absent is only the workspace UI around it.
- Its own `paths-filter` lane, NON-BLOCKING, the shape `test-eks` has.

What that deliberately does not cover is whether a real Cloudflare OS deployment is happy with our
bindings. The honest place for that is a **manual/nightly** job, opt-in behind a `GATEKEEPER_OS_REF`
pointing at a partner commit, which may go red without blocking anyone. Do not fold it into the PR
lane on the grounds that it passed a few times.

**Rejected: shipping it as a Docker image.** Raised because the repo already publishes images, so
it looks like the established path. It is not, for three separate reasons, any one of which
settles it. A Cloudflare Worker has no container runtime: it deploys through `wrangler deploy` and
develops through `wrangler dev`, so an image could only hold some second, non-Worker build of the
same idea. That second build would not be a Gatekeeper at all: Cloudflare OS reaches it over a
Worker service binding, and the credential-custody story IS "the key is a Worker secret", so a
containerized copy off Cloudflare has neither the binding nor the custody. And the published
images exist because a RUNNING deployment pulls them by tag (the executor and deploy harnesses);
nothing pulls a Gatekeeper, because the artifact an operator wants is the source they edit,
and an image would freeze the policy configuration that is the whole point of copying it.
Do not re-propose without a consumer that pulls rather than copies.

## Checklist

- [x] Slice 1: scope as data, `x-min-scope`, `@cat-factory/gatekeeper-bindings`
      ([#1804](https://github.com/kibertoad/cat-factory/pull/1804))
- [x] Slice 2: outbound webhook collection (both runtimes + conformance + SDK surface)
- [ ] Slice 3: `externalIdentity` on key provisioning, echoed on run detail
- [ ] Slice 4: reference Gatekeeper Worker (`deploy/gatekeeper`, own CI lane, unpublished)

## Gotchas the pilot surfaced

- **`minScope` is the STATIC floor, not the whole admission story.** `startPublicTask` and
  `createPublicJob` escalate to `decide` at request time when the named pipeline can park
  (`pipeline_requires_decide_scope`), and two park shapes slip past even that (see
  `public-api.md`, "Pick the right scope"). The bindings state the floor; a Gatekeeper deciding
  approval tiers should treat run-starting operations as potentially `decide`.
- **FIVE `/api/v1` routes have no contract, and they split into two kinds.** Three are
  hand-documented OPERATIONS in the spec (the two SSE streams and the artifact blob): their floor
  is a `'read'` literal in `generate-openapi.mjs` beside the hand-written entry, matching a second
  `'read'` literal in the handler, and they reach the bindings table like any other operation.
  Two are deliberately absent from the spec because they have no honest operation shape:
  `GET /api/v1/openapi.json` (`PublicDiscoveryController`) and `ALL /api/v1/mcp`
  (`PublicMcpController`), each gating on its own `'read'` literal. So a Gatekeeper's table does
  not name them, which is correct, and their floors are pinned by nothing but review. A new raw
  route joins one of those two lists; prefer a contract if the shape allows one at all.
- **The scope ladder is DERIVED, not restated.** `generate-openapi.mjs` stamps
  `x-public-api-scopes` from the contracts' `PUBLIC_API_SCOPES`, the IR requires it, and
  `emit-gatekeeper.mjs` emits the published `PUBLIC_API_SCOPE_LADDER` from that. The first
  attempt hard-coded the ladder in the emitter with a "an operation declaring an unknown rung
  fails generation" guard, and the guard cannot do that job: nothing forces an operation to
  exercise every rung, so an ADDED rung passes generation while the published copy is merely
  incomplete. The damage then lands on a consumer, silently: an unknown rung ranks -1, so
  `bindingsWithinScope` returns `[]` and a key at the new rung reads as a key with no
  permissions. The published helpers now THROW on a rung they do not carry, for the same reason:
  version skew and "no permissions" must not be the same value.
- **Re-keying a table is where the two stores stop looking alike, and both generators get it
  wrong in the same direction.** SQLite cannot re-key in place, so D1 takes the standard
  create-copy-drop-rename rebuild; Postgres can, so `drizzle-kit generate` emitted a four-statement
  in-place `ALTER`. Both need HAND-WRITTEN backfill: drizzle's version adds `name` as `NOT NULL`
  with no default and `id` as nullable and then makes it half of a primary key, which hard-fails on
  any deployment that ever registered a webhook and passes CI, because CI migrates an EMPTY
  database. Heal (add nullable, `UPDATE`, `SET NOT NULL`) then constrain, on both sides, and write
  the conformance case that puts TWO ids in one workspace: every single-endpoint assertion passes
  against a `put` still keyed on the workspace alone.
- **`contract.minScope` is enforcement, not just documentation**, wherever a controller
  references it. Lowering an annotation lowers the gate. Treat a `minScope` diff in review
  exactly like a permission change, because it is one.

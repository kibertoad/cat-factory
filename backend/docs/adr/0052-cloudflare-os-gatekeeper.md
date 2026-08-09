# ADR 0052: cat-factory as a Cloudflare OS Gatekeeper

- **Status:** Accepted (implemented)
- **Date:** 2026-08-09
- **Context layer:** the `/api/v1` contracts and the projections generated from them
  (`sdk/gatekeeper`), the Worker that consumes them (`sdk/gatekeeper-worker`), the template an
  operator copies (`deploy/gatekeeper`), and the three CI legs that drive them

Supersedes the `cloudflare-os-gatekeeper` initiative tracker, whose committed scope is complete
(ten slices). This record keeps the architecture, the decisions taken against alternatives, and the
traps the execution surfaced, which are the parts a later change has to know. The per-slice
checklists and PR links are dropped; the changelogs carry them.

## Context

[Cloudflare OS](https://github.com/cloudflare/cloudflare-os) is an open-source enterprise agent
workspace, and its integration pattern is the **Gatekeeper**: a dedicated Worker holding the
credentials for one external service, exposing typed capability bindings to workspace agents,
enforcing per-agent method allow-lists and field masking, and mediating human approvals. An agent
never sees a credential; it holds an object-capability whose methods are exactly what policy
granted.

cat-factory should be consumable that way: a workspace agent files a task, starts a run, watches it,
and answers what it parks on, with the OS's governance around every call. The benefits are all at
the organizational boundary (credential custody, non-engineer access, approvals landing in the
workspace inbox, one governance pane); the engineering core loop is untouched.

Cloudflare OS published its source on 2026-08-04. The first four slices were built against an
anticipated protocol; the review against the real one opened the alignment work that follows, and
nothing built before it had to be undone.

## Decision

**The integration is a CONSUMER of the stable public surface, not a fifth runtime facade.** The
Worker rides `/api/v1` plus the outbound webhook delivery contract, and a deployment that never
heard of Cloudflare OS is byte-for-byte unchanged. What isolates it is the dependency direction and
the CI lane, both of which the workspace states more precisely than a separate repository would:
it depends on `@cat-factory/sdk` and `@cat-factory/gatekeeper-bindings` as an outside integrator
does, nothing in `backend/packages` may depend on it, and its lanes cannot gate or be gated by the
backend suites. Keeping it here is what makes the reference implementation testable against the
same spec that generated its bindings, in the same commit that changes either.

**In core, only what must not drift from the surface it describes.** Every `/api/v1` route contract
declares a `minScope` and the controllers reference `contract.minScope`, so the declared and the
enforced scope are one value; the OpenAPI document carries it as `x-min-scope` beside the
`x-public-api-scopes` ladder it is ranked against; and a sixth emitter renders
`@cat-factory/gatekeeper-bindings`, one entry per operation with its group, method, scope floor,
transport kind and consequence hint. The table a Gatekeeper enforces policy with therefore cannot
disagree with the API it fronts, which is the `sdk/mcp` precedent.

**Two additive `/api/v1` changes made enrolment possible.** A named outbound webhook COLLECTION
beside the singular resource, keyed on a CALLER-CHOSEN id so a cold-booting Worker enrols
idempotently with no create-or-discover round trip; and an opaque `externalIdentity` on headless key
minting, pinned onto the run at admission so an OS deployment maps a run back to a person without
keeping its own key table.

**The Worker is a published library plus a copied template.** `@cat-factory/gatekeeper-worker`
holds the capability surface, the key broker, the delivery receiver, the approval inbox and the
Durable Object they keep state in; `deploy/gatekeeper` holds a policy, bindings and three lines of
wiring. Copying machinery is what makes an upgrade a re-merge against files the operator has edited,
and what makes "did you get the security fix" unanswerable from a version number.

**It serves TWO DOORS onto the same rooms.** A Cap'n Web endpoint at `/rpc` behind
`OS_SHARED_TOKEN`, for any agent runtime that speaks it, and the Cloudflare OS object model
(`GatekeeperVendor` → `CatFactoryAccount` → `CatFactoryResource` → the session) reached over native
Workers RPC, where HOLDING THE SERVICE BINDING is the authorization. Every OS-facing surface is a
facade over the machinery that already existed, never a fork of it: behaviour branches on which door
only at the door itself.

**A resource is the PAIRED WORKSPACE**, named by a URLPattern over the deployment origin. It follows
from the credential rather than from taste: this Worker holds one provisioning key, a cat-factory
key is scoped to one workspace, so one Gatekeeper serves one resource and two workspaces take two
deployments, which is also the only arrangement where their credentials sit in different secret
stores.

**Every call passes the workspace's approval queue.** Reads run, then authorize, then return (the
spec permits the later call, and it is the useful order: an authorizer that must decide first can
only describe the request). Writes are submitted against a sequential id and PERFORMED ONLY on
`applyAction`, with the entry removed before its effect runs so a redelivered decision is a refusal
rather than a second write. The tier policy stays the FLOOR beneath all of it: an operation never
granted is absent from the session, so the queue only governs calls that exist.

**Governance is verified, not assumed, in three more places.** Hooks push what the inbox already
holds, storing nothing until the workspace ENABLES a binding and asking the initiator for a fresh
callback per event. An observer is admitted when their own account's tier reaches every operation
the bound tier reaches and masks no more, and never while that tier can read a telemetry sink.
Argument validation is derived from the same generated table and runs on BOTH doors.

**Three test legs, each replacing exactly one fake.** The hermetic suite runs the assembled Worker
in real `workerd` against a scripted `/api/v1`. The live leg keeps the Worker and takes the script
away, running against a real Node deployment `@cat-factory/sdk-smoketest` boots. The OS leg keeps
the script and takes the WORKSPACE away, booting Cloudflare OS's own `workshop-backend` beside this
Worker under wrangler's test harness, pinned to a partner commit by `GATEKEEPER_OS_REF` and living
in a workflow of its own so a partner-side change can never block a merge here.

## Rationale

**Why not a separate repository.** It buys none of the isolation people expect from it: the
isolation is the dependency direction and the CI lane. What it costs is the thing that matters, a
reference implementation that can no longer be tested against the spec that generated its bindings
in the commit that changes either.

**Why not a Docker image.** A Worker has no container runtime, Cloudflare OS reaches a Gatekeeper
over a service binding, and the credential-custody story IS "the key is a Worker secret", so a
containerized copy has neither the binding nor the custody. The published images exist because a
running deployment PULLS them; nothing pulls a Gatekeeper, because the artifact an operator wants is
the source they edit.

**Why the granted operations ARE the object's methods**, installed on a per-session prototype. A
withheld operation is absent rather than a method that refuses, so there is no allow-list at the call
site to get backwards. The prototype is not a style choice: Cap'n Web deliberately refuses to serve
an `RpcTarget`'s own instance properties, so an instance-property capability is a set of methods no
caller can reach.

**Why a policy only ever SUBTRACTS.** Compilation starts from `bindingsWithinScope(tier.keyScope)`,
so a tier cannot grant above the key backing it and a retired or misspelled operation is a refusal to
serve rather than a method that 403s on every call. `keyScope` is deliberately one value doing two
jobs, the scope minted per actor and the ceiling on the grant, which is what stops the credential and
the capability disagreeing.

**Why `autoProvisionedTier` does not inherit from `defaultTier`.** `createAccount()` takes no
arguments and therefore carries no user identity, so the account id is one we mint and no `grants`
entry an operator typed can ever match it. Inheriting would widen silently in whichever direction the
deployment did not mean: a roster deployment would hand a tier to every account the workspace mints,
or turning discovery on would quietly give every unrostered `/rpc` caller one.

**Why the answer path knows no park kind.** The first cut looked for a pending `approval-gate`, so a
card raised for a requirements review, a fork, a judge verdict or a follow-up triage could never be
answered, and the failure was INVISIBLE because it reported `stale`, which is also what a card whose
run genuinely moved on reports. Card type and decision kind are two vocabularies and neither maps onto
the other, so the notification type may drive what is subscribed and what an inbox renders, and must
never drive what an answer posts. That comes from re-reading the run, every time.

**Why sharing is verified rather than refused.** A blanket refusal is defensible while there is no
rule and indefensible once there is one. The comparison is answerable because a resource is bound FOR
ONE ACCOUNT, so its tier is an upper bound on everything ever observed through it and no observation
log is needed. Identifying an observer is TWO questions, and the second is what makes the comparison
mean anything: a viewer connected to a DIFFERENT VENDOR names an account of theirs honestly, which
resolves to the auto-provisioned tier nearly every account here holds, and would pass all three tests
while holding none of the operations being shared. An observer must hold an account this Gatekeeper
MINTED.

**Why `getAutoApprovableActions()` is empty, and that is the honest answer.** The public surface
annotates a consequence only where the stakes are real money or a merged pull request, so every other
mutation is unannotated and `resolveConsequence` reads it as destructive. Filling the catalog would
mean inverting that default, which is the misreading that helper exists to stop. The test asserts the
RELATION between the catalog and what a submitted action would stamp, so a pinned `[]` cannot outlive
its meaning.

**Why the protocol shapes are transcribed rather than imported.** Depending on the partner workspace
would put their release cadence in front of this package's build, which the isolation rule refuses.
The transcription is partial on purpose and can fall behind; the answer to that is the nightly leg,
not a dependency.

**Why the OS leg is a separate workflow rather than a `continue-on-error` job.** A separate workflow
contributes no check to the aggregated gates, so a red run cannot block a merge, which is what
non-blocking has to mean for a lane whose subject is a repository we do not control.
`continue-on-error` would make the job report a pass it did not earn, and a lane nobody can
distinguish from green is a lane nobody reads.

**Rejected, and not to be re-proposed**: an `onBehalfOf` label on the start endpoints (attribution by
assertion, with per-user keys already giving the real thing); a narrower `decide:own` scope rung (the
Gatekeeper can filter to runs it tracks, and if it ever lands in core it must be an additive rung
rather than a narrowing of `decide`); a second copy of the machinery's tests in the template (it
would test the base, not the copy: what a deployment can get wrong is its policy).

## Consequences

**A change to `/api/v1` reaches this Worker through generation, not through review.** Adding an
endpoint means adding a `surface.mjs` entry, and `check:sdk` refuses a spec the projections have
fallen behind. `contract.minScope` is enforcement wherever a controller references it, so treat a
`minScope` diff exactly like a permission change.

**`minScope` is the STATIC floor, not the whole admission story.** Run-starting operations escalate to
`decide` at request time when the named pipeline can park, so a Gatekeeper deciding approval tiers
should treat them as potentially `decide`.

**Five `/api/v1` routes have no contract**, and they split two ways: three are hand-documented
operations in the spec (the two SSE streams and the artifact blob) whose floor is a literal beside
their entry, and two are deliberately absent because they have no honest operation shape
(`GET /api/v1/openapi.json` and `ALL /api/v1/mcp`). A Gatekeeper's table names only the first three,
which is correct; the last two are pinned by nothing but review.

**A deployment must carry the `allow_irrevocable_stub_storage` compatibility flag**, and the template
now does. `createAccount()` hands the workspace a stub it persists, and workerd refuses to store a
stub whose target Worker has not opted in, so without it a perfectly bound, perfectly configured
Gatekeeper is discovered and fails on the first account anyone connects. It is not reportable from
`/health`, because a Worker cannot read its own compatibility flags; the OS leg is what checks it, and
found it.

**A health check asks about EVERYTHING and fails only on what makes the deployment's own doors
refuse.** `/health` made both halves of that mistake once: it answered green off a code path reading
three of seven bindings, and later refused whenever the four object-model exports were absent, which
turned every `/rpc`-only deployment red on a version bump. What is optional is reported beside the
status (`os.discoverable` with a blocker per cause, and `limitations` for what installs and then
refuses one capability).

**Three seams no hermetic suite can reach stay with the OS leg**: the entrypoint NAMES (the workspace
resolves them and never asks this package what they are called), the stubs handed over
(`createAccount()`'s persisted stub, and a Durable Object class only the workspace's own machinery can
instantiate), and the transcribed protocol. What the OS leg in turn cannot reach is a session: the
harness runs no gadget code, so the approval queue, the argument checks and the answerers stay with
the hermetic suite.

**The MCP bridge was probed and is not a substitute.** Cloudflare OS ships `gatekeeper-mcp` and
`gatekeeper-mcp-portal`, which front any MCP server, and our hosted `ALL /api/v1/mcp` endpoint is one.
`gatekeeper-mcp` cannot reach it at all: it connects unauthenticated or runs the RFC 9728 → 8414 →
7591 chain, and this deployment publishes no protected-resource metadata, no `WWW-Authenticate` and no
dynamic client registration, so the chain dead-ends on a synthesized `/register`.
`gatekeeper-mcp-portal` with `MCP_PORTAL_AUTH: "token"` does work today, and the annotation half works
with it: our tools carry `readOnlyHint` derived from the HTTP method, so reads run as observations and
everything else queues for approval. What one deployment-wide `MCP_PORTAL_TOKEN` cannot carry is
everything the Gatekeeper exists for: per-actor key minting, `externalIdentity` attribution and the
role-scoped merge policy behind it, the tier floor, the four `withheld()` reasons (which collapse into
"tool not ticked"), and the approvals INBOX, since the bridge governs outbound calls only and the
platform's parks never reach the workspace. The bridge is a reasonable way to reach cat-factory from a
workspace that wants tools; it is not this.

**What is deliberately left open**, each waiting on a consumer rather than on effort: a rendered
protocol reference for a non-TypeScript OS integration (and then generated from the types, not
transcribed); a `WEBHOOK_SECRET` rotation recipe, which needs verifying against the enrolment and
verification code before it can be written down honestly; and a mapping from a minted account id to a
person outside the OS deployment that holds the stub, which wants the workspace's own management UI.

**Traps a later change will hit**, each learned the expensive way:

- **A stub is a LOAN whose term is the call it arrived on.** `startSession(queue)` returns
  immediately and the session uses the queue for the rest of its life, so it must `dup()` and release
  on disposal.
- **A Cap'n Web stub intercepts EVERY property, `.call` included**, so `method.call(target, args)`
  asks the far side for an operation named `tasks_get.call`. It also means `typeof stub.x` is never a
  question about the far side, so an absent-method guard can only catch the in-process case.
- **A run can hold TWO parks at once**, and the decision list is in shape order rather than priority
  order, so answering `decisions[0]` settles whichever the projection built first. `parked: false`
  does not mean nothing to answer either: follow-ups are listed while the run still runs.
- **A task with only a TITLE parks before any agent runs.** The pre-dispatch input gate is
  deterministic, so an integration that files work on a title alone gets a parked run every time and
  reports it as the platform being slow.
- **"Set it in wrangler.toml or with `wrangler secret put`" is a refusal that leaks credentials**:
  offered both, an operator picks the one that is a file, and the file is committed.
- **The scope ladder is DERIVED, never restated**, and the published helpers throw on a rung they do
  not carry, because version skew and "no permissions" must not be the same value.

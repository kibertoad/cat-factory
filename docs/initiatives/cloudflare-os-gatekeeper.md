# Cloudflare OS Gatekeeper integration

Status: in progress. Slices 1 to 4 and 6 to 9 have landed, and slice 5's first leg with them.
Cloudflare OS published its source on 2026-08-04, and the 2026-08-09 review against it (below)
unblocked slice 5's second leg and opened slices 7 to 10, the protocol-alignment work. What is
left is slice 10: the nightly leg against a real Cloudflare OS, plus the MCP-bridge probe.
Cloudflare OS support is the goal of this initiative; the matured integration surface the
alignment forces is the side product, not the other way round.

**Slices 7 and 8 landed TOGETHER, and the sequencing is worth recording** because the tracker had
them apart. Separately, neither is shippable: the object model without a session is a vendor a
workspace can discover and never use (`getGatekeeperClassFor` is where the model turns into
something), and a session without the queue violates the contract's central requirement in the one
place the published spec leaves no room ("there is no mode in which it's OK to skip the check").
Landing 7 alone would have meant shipping one of those two and fixing it in the next slice, so the
smallest honest increment is both. Slices 9 and 10 are unaffected and stay open.

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

**The Worker itself lives in this repo, as isolated and separately gated packages**: the machinery
in `sdk/gatekeeper-worker`, published and installed, and the template an operator copies in
`deploy/gatekeeper`, beside the other example deployments (slice 4 built one package; slice 6 split
it along that line). What makes it a consumer is
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

### 3. Key provisioning metadata (landed)

An opaque `externalIdentity` on `POST /api/v1/keys`, echoed on the key resource and on run
detail, so an OS deployment can map a run back to the person whose per-user key started it
without keeping its own keyId table. Shipped as an additive field on both runtimes' key rows
(`external_identity`, D1 0086 ⇄ Drizzle), echoed on the key resource, on `GET /api/v1/me` and on
BOTH run projections (`publicRun`, `publicJob`), OpenAPI 1.30.0.

Four decisions worth carrying forward:

- **The run PINS its own copy at admission; nothing joins back to the key.** An integration
  revokes a per-user key the day that person leaves, which is exactly when the mapping is still
  wanted, so a resolved read would answer `null` from then on. Pinning also keeps a page of runs
  from being a page of key reads, and matches what the run already does with `initiatedByRole`
  and `mode`. It rides `agent_runs.detail`, so the conformance case asserts the identity survives
  BOTH the store round-trip and the key's revocation.
- **A retry keeps the identity, and never re-takes it from whoever drove the re-drive.** Same
  work, same requester: re-pinning would attribute the run to the operator who pressed retry, or
  (from a sweeper, which presents no key) to nobody.
- **A key that HAS an identity reads it back only on its own runs.** One key per person is the
  shape this slice is for, and without a rule it hands every person's key the roster of everyone
  else, off a value that is routinely an email. A key with no identity (the gatekeeper's own
  provisioning key, or one a member minted in the app) still reads every run's, which is where the
  mapping is meant to be done. The projections carry `externalIdentityWithheld` beside the value
  rather than blanking it, because `null` already means "this run names nobody" and the two are
  different facts: a withholding the platform does not state reads as an attribution it never had.
  It costs no lookup, both values being in hand already (the run's pin, and the calling key's own
  identity, which rides the authenticated context).
- **It is never inherited from the provisioning key.** A provisioner mints for many identities, so
  the obvious default would name the integration itself on every run it starts for anyone, which
  is the answer this field exists to improve on.

Offered on the headless mint only. The session-authed create already records `createdByUserId`,
an account the platform can resolve; this field is for the identity it cannot.

**Rejected: an `onBehalfOf` label on the start endpoints.** Attribution by assertion with no
enforcement behind it; per-user keys already give the real thing. Do not re-propose.

**Rejected: a narrower `decide:own` scope rung, for now.** The Gatekeeper can enforce
"answer only runs the OS started" itself by filtering to runs it tracks. If it ever lands in
core it must be a new additive rung, never a narrowing of `decide`.

### 4. Gatekeeper reference implementation (`deploy/gatekeeper`) (landed)

The Worker consuming `@cat-factory/gatekeeper-bindings`: Cap'n Web capabilities over the policy
table, the webhook receiver, the approval-card flow, per-actor key minting. An example deployment
template like its neighbours (`deploy/backend`, `deploy/frontend`): an operator copies it, points
it at their own workspace and edits `src/policy.config.ts`.

Three constraints made "in the repo" and "isolated" both true, and all three held:

- **Dependency direction, enforced by the workspace.** It depends on the published surface
  (`@cat-factory/sdk`, `@cat-factory/gatekeeper-bindings`) and nothing in `backend/packages` may
  depend on it. `knip` and `sherif` already see the workspace, so an import in the wrong direction
  is a CI failure rather than a convention.
- **Its own CI lane.** A `gatekeeper` `paths-filter` output gating a job of its own, the shape
  `eks` already has. It must not join the aggregated `Test` gate while the Cloudflare OS protocol
  is still moving: a partner-side breaking change should not turn this repo's CI red.
- **Not a published package.** `private: true`, no changeset, no npm release. It is read and
  copied, not installed. (Slice 6 SPLIT this: the template is still copied and still unpublished,
  but the machinery under it is now installed rather than copied. What that bullet got right is
  the part that survived: what an operator wants to own is the source of their policy, and the
  reason to publish the rest is that they never wanted to own THAT.)

Four decisions worth carrying forward:

- **The granted operations ARE the object's methods**, installed on a per-session PROTOTYPE. So an
  operation policy withheld is not a method that refuses, it is absent, and there is no allow-list
  at the call site to get backwards. The prototype is not a style choice: Cap'n Web deliberately
  REFUSES to serve an RpcTarget's own instance properties (they would leak private internals), so
  an instance-property capability is a set of methods no caller can reach.
- **A policy is compiled against the live table and only ever SUBTRACTS.** Compilation starts from
  `bindingsWithinScope(tier.keyScope)`, so a tier cannot grant above the key backing it and a
  retired or misspelled operation is a refusal to serve rather than a method that 403s on every
  call. The corollary is that `keyScope` is ONE value doing two jobs (the scope minted for each
  actor, and the ceiling on the grant), which is what stops the credential and the capability
  disagreeing. `admin` is unreachable as a `keyScope` and says so: `POST /api/v1/keys` cannot mint
  it, so a tier asking for it is asking for the Gatekeeper's own provisioning secret.
- **What is NOT granted is published beside what is**, with the reason separated three ways:
  `denied_by_policy`, `above_key_scope` and `not_relayable` (an SSE stream or a binary blob cannot
  cross a Cap'n Web call). An agent that cannot tell "your policy hides this" from "no policy can
  grant this" from "ask for it another way" reports the wrong one to whoever has to fix it.
- **Answering an approval re-reads the run, every time.** The card carries no `approvalId` (the
  notification does not have one) and the run may have moved between the delivery and the answer,
  so the card is a POINTER and the decision list is the truth. That is also what makes the three
  outcomes distinguishable: `answered`, `recorded` (the vote counted but the quorum is unmet, so
  the run is still parked) and `stale` (with the run's own `unanswerable` entry quoted). Collapsing
  them into "it worked" is the integration bug the platform's docs warn about.

#### The review of the first cut, and what it changed (same slice)

The reference implementation shipped understanding ONE of the platform's thirteen park kinds, and
the review of it found that the shape of the mistake mattered more than its size. Five corrections
landed, and each is a rule worth carrying into anything else that consumes this surface.

- **The answer path may not know any kind.** `approvals_answer` looked for a pending
  `approval-gate`, so a card raised for a requirements review, a fork, a judge verdict or a
  follow-up triage could never be answered from the inbox, and the failure was INVISIBLE, because
  it reported `stale`, which is also what a card whose run genuinely moved on reports. The fix is a
  data table (`policy/decisions.ts`, in the machinery package since slice 6) keyed on the SDK's own
  `PublicDecision['kind']` union with
  `satisfies Record<…>`, so a park the platform adds fails this package's BUILD. The shipped
  `approver` tier derives its grants from that table for the same reason: fifteen hand-typed
  decision bindings against a surface carrying more than forty is a tier that answers the parks
  somebody remembered.
- **A card the surface cannot settle is a NOTICE, and says so.** `merge_review` is answered by a
  real merge (`notifications_act`), deliberately withheld from every tier because the merge policy
  wants a person the platform can name (ADR 0037/0039). Subscribing to it was right; presenting it
  as answerable was not. The type list became a map to a `disposition`, stamped onto the card.
- **`stale` settles nothing.** The card was being resolved as `superseded` on the first stale
  answer, which destroys the inbox entry of a run that may still be parked. The platform
  re-delivers a card under a NEW notification id, so a wrongly settled one is never re-raised. Only
  an answer that leaves the run UNPARKED settles the card.
- **A dedupe marker and the effect it guards are ONE write.** They were two Durable Object calls,
  so a failed card write turned the platform's retry into a `duplicate` and the approval reached
  nobody, silently. `applyDelivery` now does both in one multi-key `put`, which is exactly the
  repo's own "commit the local state first, and a claim that ERRORS must propagate" rule arriving
  from the receiver's side.
- **A cached credential needs a claim in front of it and an invalidation behind it.** `POST
/api/v1/keys` returns its secret exactly once, so a read-then-mint-then-write has two pipelined
  first calls both minting and the loser's key live upstream with nothing recording it; and a cache
  with no 401 path makes the documented kill switch (rotate the provisioning key) a permanent
  outage. Both are now the standard shapes: an atomic, EXPIRING claim taken before the effect, and
  one re-mint on a 401. The mint race is the one fact not observable in a response, so the scripted
  origin counts what it was asked to issue.

The two additions that make it a base rather than a sample fall out of the same work:
`approvals_inspect` (the live park, its verbs, the fields each needs, and whether this tier holds
the operation behind it) and `runs_watched` (the lifecycle projection the `run.*` subscription was
already paying for and then discarding). Offboarding moved onto the admin surface as
`POST /admin/retire`, because revoking another person's keys is a decision the OS makes ABOUT them.

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

### 5. The two legs a scripted origin cannot cover

Both are ADDITIONS to the slice-4 suite, never replacements for it, and both are non-blocking by
construction. Neither is a prerequisite for using the Gatekeeper; they exist to catch a
disagreement the hermetic suite structurally cannot see.

- **Against a real `/api/v1` (landed).** A `--only=gatekeeper` phase in
  `backend/internal/sdk-smoketest`, which already boots the real Node facade and mints keys, running
  the machinery package's own `test/live` specs against it. The reason it belongs THERE rather than
  in `deploy/gatekeeper` is the one the smoketest itself gives: the harness that boots a backend
  should be the one that owns the boot, and the template an operator copies should not carry a
  Postgres-shaped devDependency.
- **Against a real Cloudflare OS (open, and no longer blocked by anything but the job).**
  Manual/nightly,
  opt-in behind a `GATEKEEPER_OS_REF` pointing at a partner commit, allowed to go red without
  blocking anyone. Do not fold it into the PR lane on the grounds that it passed a few times. The
  partner ref it was blocked on now exists, and slice 7 has landed the `GatekeeperVendor`
  entrypoint a service binding targets. Details: slice 10.

#### What the live leg is, and the four decisions in it

The Worker is not re-composed in Node and nothing about it is substituted: the SAME assembled
Worker runs in the SAME pool as the hermetic suite, with the scripted origin removed
(`vitest.live.config.ts` sets no `outboundService`), so the SDK's calls leave workerd and land on the
harness's deployment. It enrols on the real named-webhook collection, mints a real per-actor key and
recovers from its revocation, forwards the everyday loop, and answers a run that really parked.

- **The claims live in the SPECS, and the phase grades only that they ran.** They need workerd and a
  Cap'n Web session, which exist in that package and not in a Node harness; what the harness has and
  the package must not is a database. So the phase reads the JSON REPORT's per-assertion statuses
  rather than its exit code or its totals: a suite that collected nothing also exits 0, and so does
  one whose specs were every one of them SKIPPED, which the totals still count as tests. This
  repo's own rule is that a phase which reported nothing is not a pass.
- **The workspace is asked to PARK, per workspace.** `startBackend` clears `E2E_DECISION_ON_STEPS`
  for every other phase (a park would stop the SDK scenario before it observed any progress), so
  this phase sets `decisionOnSteps: [0]` for its own workspace over the control channel. A
  Gatekeeper whose reason to exist is answering parked runs, smoketested against a deployment that
  never parks one, would be a suite asserting the easy half.
- **The card is raised from the platform's OWN notification.** A public `https` endpoint is required
  at registration and rightly so, so no loopback receiver can be registered and no delivery can
  actually travel. Rather than script a card, the specs read the notification the parked run really
  raised, assert it is a type this Gatekeeper subscribes to and dispositions as answerable, and wrap
  THAT object in the envelope the platform's own channel composes. What stays synthetic is the
  wrapper and the MAC, both of which the hermetic suite pins; what is real is every field a card is
  built from. The residual gap is stated in the spec's header rather than left to be inferred.
- **It runs in the Gatekeeper's own NON-BLOCKING lane, not in the blocking smoketest job.** That is
  also why the phase is asked for BY NAME rather than joining the everything run, and why the
  summary prints it as NOT RUN there: a section that is simply absent reads as a section that
  passed. The lane's `paths-filter` gained the publicApi controllers, `orchestration`, and the two
  harness paths; it did not need the contracts, because a contract change that moves the surface
  must regenerate `sdk/gatekeeper/src/bindings.generated.ts` (`check:sdk` refuses otherwise), which
  is already in the filter. BEHAVIOUR that moved under an unchanged contract is the case that
  needed adding, and it is exactly what this leg exists to catch. `orchestration` is in it for the
  same reason one layer down and is not optional: the suite's central claim is that a real run
  parks, raises the notification the card is built from, and leaves the park when answered, none of
  which lives in the controller that serves them, so a filter naming only the controllers skips the
  lane on precisely the changes that would break it. The line stops there rather than reaching the
  repositories, which conformance already covers cross-runtime and this suite adds nothing to.

**Slice 7 has now landed, so the only thing standing in front of this leg is the job itself.**

**What blocked the second leg, and what changed**: it needed a ref to pin, and
`cloudflare/cloudflare-os` (public since 2026-08-04) provides one: the repo boots reproducibly
through its own `run-dev-server.js` and pins the entrypoint contract a service binding targets.
The opt-in shape stays as agreed (`GATEKEEPER_OS_REF`, nightly, `continue-on-error`), and the job's
value is still that a red run means something, so pin a partner commit, never track their main.
What stood ahead of it was our own slice 7, which has landed: the binding now has a
`GatekeeperVendor` entrypoint to target.

### 6. Base and template: `@cat-factory/gatekeeper-worker` (landed)

Slice 4 shipped one package that was two things: ~2,400 lines of machinery nobody wants to own,
and ~120 lines of policy and wiring that are the whole reason a deployment exists. Copying the
first is what makes an upgrade a re-merge against files the operator has edited, and it is also
what makes "did you get the security-relevant fix" a question nobody can answer from a version
number. So the machinery became a published library and the template became what it always claimed
to be: `sdk/gatekeeper-worker` (`@cat-factory/gatekeeper-worker`) holds the Cap'n Web capability
surface, the key broker, the delivery receiver and verifier, the approval inbox and its per-park
answerers, and the Durable Object all four keep state in; `deploy/gatekeeper` keeps
`policy.config.ts`, `wrangler.toml`, a three-line entry point and the test of its own tiers.

Five decisions worth carrying forward:

- **The policy is an ARGUMENT, never an import.** `createGatekeeperWorker({ policy })` and
  `Gatekeeper.create(env, policy)` take it; nothing in the base reaches for a `policy.config.ts`.
  A base that imported one would own the file the deployment is supposed to write, which is the
  fork the split exists to prevent.
- **The policy vocabulary is its OWN entry point** (`@cat-factory/gatekeeper-worker/policy`). The
  package root reaches `cloudflare:workers` for the Durable Object, so a policy file importing
  through it could only be loaded inside workerd, and a policy is precisely the thing an operator
  authors, reviews and TESTS. With the split, `deploy/gatekeeper`'s suite is a plain Node run over
  its own tiers, and the template carries no workerd harness for code it did not write.
- **It sits under `sdk/`, beside the table it enforces policy against, not under `deploy/`.** It is
  a published library an outside deployment installs, and `sdk/` is where this repo's other
  consumers of the stable public surface live; `deploy/*` is for things that are copied. The cost
  is that one member of that tree is hand-written rather than generated, which `sdk/AGENTS.md` and
  `sdk/README.md` now say in as many words. The benefit is that `pnpm build` already covers it, so
  the machinery's build and typecheck are gated by the required `Build & typecheck` check even
  though its workerd suite stays in the non-blocking lane.
- **The workerd suite went WITH the machinery**, driving a Worker this package's own factory builds
  from a FIXTURE policy (`test/fixture-policy.ts`). Leaving it in the template would have published
  a library tested only by a package nobody installs, and pinning it to the shipped example policy
  would make every edit an operator is invited to make a failure in this repo. The fixture keeps
  the example's tier names and actor ids so a reader comparing the two sees one shape.
- **The template's entry point and the suite's are the same three lines.** `test/worker.ts` is
  byte-for-byte what `deploy/gatekeeper/src/index.ts` is, which is the cheapest available check
  that the base has a seam for everything a deployment needs: a line the suite's Worker needs and
  the template's does not have would be a missing one.

**Rejected: a second copy of the machinery's tests in the template.** Raised because a copied
template with no end-to-end test looks under-covered. It would test the base, not the copy: what a
deployment can get wrong is its policy, and that is exactly what `deploy/gatekeeper`'s remaining
suite covers.

### The 2026-08-09 review against the published protocol (opens slices 7 to 10)

Cloudflare OS published its source on 2026-08-04, and the protocol slice 4 could only anticipate
is now one readable file: `packages/workshop-shared/src/gatekeeper.ts` (~1,100 lines, most of it
normative JSDoc), with sixteen reference gatekeepers beside it (`gatekeeper-github` the richest,
`gatekeeper-google` the cited OAuth model, `gatekeeper-email` the minimal no-OAuth one). The
review compared this implementation against that source. Verdict and findings are recorded here so
the alignment work starts from them instead of re-deriving them.

**What holds up.** The machinery's idioms are the official ones. Capabilities are `RpcTarget`
subclasses whose granted operations are methods and whose withheld operations are absent; the
per-session prototype (Cap'n Web refuses instance properties) matches the reference
implementations' own workaround; credentials live in Worker secrets and Durable Object storage
and never reach an agent, which is the official custody story too (per-account tokens in a DO);
the claim-before-mint and single-turn atomic writes in `state.ts` are correct DO concurrency the
official examples do not exceed. Nothing in slices 1 to 6 needs undoing.

**Where the published contract diverges from what slice 4 assumed**, ranked by interop cost:

1. **Discovery and transport.** The OS discovers gatekeepers by scanning its env for
   `GATEKEEPER_*` SERVICE BINDINGS (`workshop-backend/src/auth/auth-vendors.ts`), each targeting
   a `WorkerEntrypoint` export named `GatekeeperVendor` (pinned in `run-dev-server.js` and the
   release manifest), reached over native Workers RPC. There is NO shared token anywhere in the
   official model: holding the binding or a minted stub IS the authorization. Our Worker exports
   a default `fetch` serving Cap'n Web over HTTP at `/rpc` behind `OS_SHARED_TOKEN`, so a real OS
   cannot discover, install or call it. Cap'n Web is real in that repo, but browser-to-backend
   and gadget-side; "the OS's own protocol" framing in our docs was wrong (doc gap below).
2. **The approval flow runs in the opposite direction.** The contract's heart is the
   `ApprovalQueue` the OS hands to `startSession()`: "Every operation performed through this
   session must be submitted to the approval queue. Observations (read-only operations) must be
   authorized before data is returned to the caller", and for side effects "there is no mode in
   which it's OK to skip the check" (spec, verbatim). Actions settle asynchronously
   (`applyAction` / `rejectAction` / `revertAction` may arrive days later), and the signature
   idea is SIMULATION: stage the write under a provisional id so the agent keeps working. Our
   capability invokes immediately and publishes consequence metadata so the OS can govern the
   call itself, which delegates precisely the duty the contract assigns to the gatekeeper. Our
   approvals INBOX is the reverse direction (the platform's parks surfaced to the OS), a feature
   the official pattern carries as HOOKS; the two must not be conflated.
3. **Identity is established, not asserted.** Officially each user connects their own vendor
   account through a nonce-protected OAuth flow, and identity thereafter travels as a
   props-imbued entrypoint stub the OS persists. Our `connect({ actorId })` trusts a string over
   the shared-token channel. cat-factory has no per-user OAuth, so the honest mapping is the
   official `createAccount()` / `autoProvisionsAccount` escape hatch (`gatekeeper-email` is the
   model), a recognized low-trust variant rather than a violation; but the per-actor attribution
   is only as good as the OS's assertion, and should say so.
4. **The object model and introspection surface are absent.** Officially: `GatekeeperVendor`
   (`describe()`, `connectAccount()`, `getSupportedResources()`, `getTypeScriptTypes()`) over a
   per-account `GatekeeperUser` over a per-resource `Gatekeeper` Durable Object over `Session`,
   resources named by URLPattern (`https://github.com/:owner/:repo`), sessions being curated
   typed domain APIs returning sub-capabilities and `Cursor<T>` pagination, with runtime argument
   validation generated from the declared signatures (`capnweb-validate`). Ours is a flat
   generated table of operations taking untyped argument bags. The official repo contains a
   gatekeeper shaped exactly like ours: `gatekeeper-mcp`, the MCP bridge (`readOnlyHint` tools
   run as observations, everything else queues). Architecturally we shipped a sibling of the
   bridge, not of the first-class gatekeepers.
5. **Policy sits on one side there and the other side here.** Official gatekeepers DESCRIBE
   (`actionKind` tags, `autoApprovable`, `implementsRevert`, `getAutoApprovableActions()`) and
   the OS DECIDES (kernel chokepoint, admin rules). Our tiers, allow/deny and masking compile
   inside the gatekeeper. Both engines have a job (slice 8): ours is the floor, theirs the
   governance above it, and neither replaces the other.
6. **Smaller contract items.** No observer/verifier sharing governance (`addObserver` must
   verify a new viewer could directly read everything historically observed, or throw to block
   the share); a hook delivery is itself an observation to authorize. (The `[Symbol.dispose]` /
   `.dup()` stub lifecycle was on this list and landed with slice 7.)

**Governing principle for slices 7 to 10: organic evolution, never a Cloudflare-OS-specific
hack.** OS support is the goal and a matured integration surface is the side product, and the way
to get both is to refuse any change that only makes sense for one caller:

- **Every OS-facing surface is a FACADE over the existing machinery**, never a fork of it. The
  key broker, the compiled policy, the DO state and the answerers stay the one implementation;
  behaviour may branch on "which door" only at the door itself.
- **Anything the OS wants that is derivable from the bindings table IS generated** (the
  descriptions, the resource list, the `.d.ts`), the same no-drift rule slice 1 established. A
  hand-transcribed introspection surface would drift exactly the way the hand-curated allow-list
  the table replaced would have.
- **The `/rpc` Cap'n Web surface and the shared-token admin routes STAY.** "Nothing here is
  Cloudflare-specific" is a promise the bindings README makes and non-OS consumers rely on; the
  entrypoint is a second door onto the same rooms, not a replacement.
- **One name per concept.** Where our concept and the official one are the same fact, adopt
  their vocabulary at the seam (`ObservationDescription`, `ActionDescription`, hooks); where ours
  is the stronger rule (tier compilation that only subtracts, claim-before-mint), keep ours and
  map at the edge. Carrying two names for one thing is how the next reader concludes they are
  two things.

### 7. The OS-facing entrypoint (landed, with slice 8)

The official object model exported from `@cat-factory/gatekeeper-worker`, in front of the machinery
that already existed: `GatekeeperVendor` (a named `WorkerEntrypoint`) → `CatFactoryAccount` →
`CatFactoryResource` (a Durable Object) → the session. Four exports the deployment's entry module
names, resolved at runtime as `ctx.exports.<Name>`, with `/health` asking about all four in one pass
because a perfectly bound Worker whose entry module is three lines short is undiscoverable and that
failure has no request path of its own. It REPORTS the answer (`os.discoverable`, with a blocker
per cause) rather than refusing on it: see the gotcha below on what a check may and may not fail.

**A resource is the PAIRED CAT-FACTORY WORKSPACE, named by a URLPattern over the deployment
origin** (`<CAT_FACTORY_BASE_URL>/*`). It follows from the credential rather than being a modelling
preference: this Worker holds one provisioning key, a cat-factory key is scoped to one workspace,
and `STATE` already keys on the deployment origin for the same reason. So one Gatekeeper serves one
resource, and two workspaces take two Gatekeepers, which is also the only arrangement in which their
credentials sit in different secret stores. A URL the pattern does not match is a refusal that says
this, rather than a bind that silently succeeds against the wrong workspace.

Four more decisions worth carrying forward:

- **Identity on this door is STRONGER than on `/rpc`, and it forced a second policy knob.**
  `createAccount()` "takes no arguments, so it carries no user identity" (the spec's own words), so
  the account id is one we MINT and the workspace's persistence of the stub is what makes it stable
  and per-user. That is better than `connect({ actorId })`, which trusts a string. But it means a
  `grants` map keyed on an identity an operator typed can never match an account, so the policy
  gained `autoProvisionedTier`, which does NOT inherit from `defaultTier`. Inheriting would widen
  silently in whichever direction the deployment did not mean: a roster deployment would hand a tier
  to every account the workspace mints, or turning on discovery would quietly give every unrostered
  `/rpc` caller one. `grants` is still consulted first, by the account's own id, which is the one
  affordance for raising a single account (surfaced as `AccountDescription.uniqueName`).
- **The types are composed PER TIER, not shipped whole.** `pnpm gen:sdk` emits one method signature
  per operation (`sdk/gatekeeper/src/session-types.generated.ts`) and `renderSessionTypes` composes
  the granted subset. A `.d.ts` naming the full surface would promise methods the object does not
  have, which is the same lie the hand-curated allow-list the table replaced used to tell.
  Composition THROWS on a name it has no signature for: a silently dropped method reads to an agent
  exactly like an operation the deployment does not serve, and the two need opposite fixes. Results
  are `unknown` and say so, because inlining the model tree would put a second copy of it in every
  Worker bundle, free to disagree with the OpenAPI document it came from.
- **The verifier is a FOURTH export, not the account.** `getVerifier()` hands a stub to another
  vendor's gatekeeper, and the account object carries `revoke()` and the resource classes. An
  identity token has to carry no authority, so it is its own entrypoint with one method.
- **A resource's BEHAVIOUR lives in `ResourceCore`, not in the Durable Object.** workerd will only
  construct a DO from a real `DurableObjectState`, and the props-imbued class handed to the
  workspace is opaque by design, so a suite reaching this only through the object could assert
  little more than that a class came back. The DO is the shell that supplies `ctx.props` and holds
  one core for its lifetime, which is what the action ledger needs.

### 8. The approval queue (landed, with slice 7)

Threaded onto the ONE `invoke` closure in `buildCapability`, through an optional `SessionGovernance`
on `SessionDependencies`. A door with no governance passes nothing and gets byte-for-byte the prior
behaviour, which is what keeps `/rpc` the promise this package goes on making.

- **Reads run, then authorize, then return.** The spec allows calling `authorizeObservation` after
  the upstream fetch, and that is the useful order: an authorizer that must decide first can only
  describe the request. A refusal throws, so nothing reaches the caller either way. Reads served
  from our own DO projection (`approvals_list`, `runs_watched`, a card lookup) are authorized too:
  they are observations of the paired deployment, and that the bytes are local is an implementation
  detail of how they arrived.
- **Writes are submitted and PERFORMED ONLY on `applyAction`.** `submitAction` returns when the
  action is queued, not when it is decided, so the effect is registered unperformed against a
  sequential id and the awaiting call is resolved by the decision. Ids are per RESOURCE OBJECT, not
  per session, because that is what the workspace calls back on. The ledger is in MEMORY on purpose:
  the awaiting caller is a suspended RPC into that object, so nothing can be evicted underneath it,
  and persisting would only let a later apply perform a write whose result nobody reads. An entry is
  removed BEFORE its effect runs, so a redelivered decision is a refusal rather than a second write.
- **`ActionDescription` is derived, not authored**, and three fields are fixed with reasons:
  `implementsRevert: false` (a started run or a merged PR is not ours to undo, and the flag exists
  so the UI does not offer an undo that would not work), `awaitDecision: true` (we do not simulate,
  so the spec's alternative is to suspend the agent's turn), and `autoApprovable` from
  `resolveConsequence`. **`getAutoApprovableActions()` is empty today and that is the honest
  answer**: the surface annotates a consequence only where the stakes are real money or a merged
  PR, so every other mutation is unannotated and reads as destructive. Filling the catalog would
  mean inverting that default here, which is exactly the misreading `resolveConsequence` exists to
  stop. The test asserts the RELATION between the catalog and what a submitted action would stamp,
  so a pinned `[]` cannot outlive its meaning.
- **The argument bag reaches a human, so it is FENCED.** The description is Markdown shown to an
  approver and the arguments are agent-authored: the fence is sized one tick longer than the longest
  backtick run in the payload, the repo's own rule for captured output crossing a rendered surface.
- **The tier policy stays the FLOOR.** An operation policy never granted is absent from the session,
  so the queue only ever governs calls that exist.
- **Simulation is NOT built.** Provisional ids, a staged-action overlay on reads and a real
  `revertAction` are a later slice if the run/task domain ever wants them. `revertAction` answers
  with what a person has to do themselves rather than throwing, because the caller is the workspace
  UI on behalf of someone who wants their change undone.
- **`addObserver` REFUSES, which is slice 9's stated safe default arriving early.** It cost one
  method and a share blocked loudly beats an observation leaked quietly. `removeObserver` is the
  idempotent no-op the contract asks for. The eventual rule still belongs to slice 9.

**Rejected: transcribing the partner's types as a dependency.** The protocol shapes are transcribed
into `src/os/protocol.ts` rather than imported, because depending on the partner workspace would
make their release cadence this package's build, which the initiative's own CI rule refuses. The
transcription is partial on purpose (it carries what this Worker implements or is handed) and can
fall behind; the answer to that is slice 10's nightly leg, not a dependency.

### 9. Hooks, sharing, and the session contract's small print (landed)

Three items that had nothing in common except being what the contract asks for beyond the object
model and the queue. Each landed as the rule it was waiting for, and the rules are worth carrying.

**Hooks push what the inbox already holds** (`approvals_subscribe` / `runs_subscribe`, plus
`hooks_bound`). The lifecycle is the published one: a session hands the queue a CONTROLLER of its
own (a fifth named export, `CatFactoryHookController`), the workspace enables it later, and each
event asks the initiator for a FRESH callback and authorizes the delivery before it is pushed.

- **Nothing is stored until the workspace ENABLES it.** The contract asks for that literally, and
  the reason is not tidiness: a row written at bind time is a registration for a hook nobody
  approved, and the set of those grows with every agent that ever asked.
- **The registry lives in the delivery's own durable object**, because that is the only place the
  live half CAN live: a stub is a reference into another Worker and cannot be written to storage,
  so the object that is already woken by every delivery is the one that can hold it. The
  consequence is stated rather than hidden: an eviction between two deliveries keeps the record and
  loses the stub, so a push with no live half COUNTS as `missed` on the record and `hooks_bound()`
  publishes it beside `live`. A hook that goes quiet is otherwise indistinguishable from a
  deployment where nothing happened, which is the one reading a workspace must never be left to
  make on its own. That is also why the hook is an accelerator and never a source of truth.
- **The push is BEHIND the write, and every failure is a count rather than a throw.** The card
  commits first, then the fan-out; a workspace that refuses or a gadget that has gone away costs a
  notification and never the record. The 202 the platform's own delivery log keeps carries the
  report (`hooks: { delivered, stale, failed }`), so "was it pushed" is answerable without
  comparing an inbox against a gadget.
- **A missing export costs a CAPABILITY, not the door**, which forced `/health` to answer in two
  parts: `blockers` (a workspace that never finishes installing) and `limitations` (one that
  installs, serves, and refuses hooks). Folding the second into the first would turn every
  `/rpc`-only deployment red on a version bump, which is the mistake this route has now made in
  both directions once (see the gotchas).

**Sharing is now VERIFIED rather than refused.** The rule slice 8 asked for: an observer is
admitted when their own account's tier reaches every operation the bound tier reaches and masks no
more, and never at all while the bound tier can read a telemetry sink (those reads are described
`prohibitAllSharing`, which is a statement about the data rather than about the viewer, and nothing
records which of them were made). It is answerable because a resource is bound FOR ONE ACCOUNT, so
the tier is an upper bound on everything ever observed through it, and no observation log is
needed. Two corollaries: an observer this Gatekeeper cannot IDENTIFY is refused separately
(`sharing_unverifiable`), because "unknown" and "not permitted" are the same outcome and opposite
facts; and every admitted observer can read everything, so `excludeObservers` stays unused rather
than becoming a second, weaker gate on the same question.

**Argument validation is derived from the table, and runs on BOTH doors.** The contract asks for a
call carrying an argument the receiver does not declare to be rejected, and `capnweb-validate`
generates that from the declared signatures; ours is generated already, one layer down, because
every binding carries its path parameters, its query parameters with requiredness, and whether it
takes a body. The reason it earns its place is the SILENT DROP it replaces: an unrecognised filter
used to be forwarded as nothing at all, so an unfiltered answer came back shaped exactly like a
filtered one. It runs ahead of the key broker and the queue, so a call that cannot succeed mints no
credential and spends no approval, and it is deliberately not door-specific: `/rpc` had the same
bug. What it does NOT check is what a value may BE, which is the deployment's judgement and is
already stated in the spec these bindings come from.

**Rejected: keeping the blanket `addObserver` refusal and documenting it.** It is defensible while
there is no rule and indefensible once there is one: the tier comparison is exactly the question
the contract asks, and a permanent refusal would push every share onto a second account nobody
manages.

### 10. The live leg, and the MCP-bridge probe

- **Land slice 5's second leg**, now unblocked: slice 7 gave the binding its target. Nightly,
  opt-in behind `GATEKEEPER_OS_REF`, `continue-on-error`, booting the partner repo through its own
  `run-dev-server.js` with `GATEKEEPER_CAT_FACTORY` bound to our Worker. It is also what keeps the
  transcribed protocol types in `src/os/protocol.ts` honest, which is the one thing no hermetic
  suite here can check.
- **Probe the official MCP bridge first, and record the outcome either way.** `gatekeeper-mcp` /
  `gatekeeper-mcp-portal` can front our existing hosted MCP endpoint (`ALL /api/v1/mcp`) today,
  which would exercise the platform's side of the loop cheaply. It is a PROBE, not the destination: the bridge cannot
  carry per-actor key minting, `withheld()`'s four reasons, the tier floor or the approvals inbox,
  which are the reasons this Worker exists. Slices 7, 8 and 9 have since landed, so what a probe is
  still worth is a second reading of the approval UX against one that already exists; do not let a
  working bridge demo stand in for the nightly leg above, which is the only thing that reads the
  transcribed protocol types against a real workspace.

## Checklist

- [x] Slice 1: scope as data, `x-min-scope`, `@cat-factory/gatekeeper-bindings`
      ([#1804](https://github.com/kibertoad/cat-factory/pull/1804))
- [x] Slice 2: outbound webhook collection (both runtimes + conformance + SDK surface)
- [x] Slice 3: `externalIdentity` on key provisioning, echoed on run detail
- [x] Slice 4: reference Gatekeeper Worker (`deploy/gatekeeper`, own CI lane, unpublished), plus
      the review corrections above (every park answerable, card dispositions, atomic delivery,
      claimed minting, `approvals_inspect` / `runs_watched` / `POST /admin/retire`)
- [ ] Slice 5: the two legs the scripted origin cannot cover
  - [x] Against a real `/api/v1`: `sdk/gatekeeper-worker/test/live` + the smoketest's
        `--only=gatekeeper` phase, in the non-blocking Gatekeeper lane
  - [ ] Against a real Cloudflare OS: unblocked by the published repo, and no longer blocked by
        slice 7 either, which has landed the entrypoint the binding targets (see slice 10)
- [x] Slice 6: base/template split (`@cat-factory/gatekeeper-worker` published, `deploy/gatekeeper`
      down to its policy, bindings and wiring)
- [x] Slice 7: the OS-facing entrypoint (`GatekeeperVendor` facade, generated
      describe/resources/types, the resource decision, identity via `createAccount()` plus the
      `autoProvisionedTier` knob it forced)
- [x] Slice 8: the approval queue (observations authorized, actions submitted and performed only on
      `applyAction`, `ActionDescription` derived from the table, tier floor kept)
- [x] Slice 9: hooks and sharing governance (cards and run events over `bindHook`, the observer
      rule that replaced the refusal default, argument validation on both doors)
- [ ] Slice 10: the live leg (`GATEKEEPER_OS_REF`, after slice 7) and the MCP-bridge probe,
      outcome recorded either way

## Open documentation gaps

Registered by the 2026-08-08 documentation revision
([#1845](https://github.com/kibertoad/cat-factory/pull/1845)), which restructured the three READMEs
(bindings, machinery, template) around what each piece is, its purpose, usage, configuration and
customization, added the Gatekeeper naming map to `docs/glossary.md`, documented `deny`, masking
semantics, the reserved capability methods and the error split, and fixed the template README's
withheld-reason list (it named three of the four). What that sweep could NOT close stays open
here:

- [ ] **A rendered protocol reference for the OS side.** The shapes an OS consumer receives
      (`ApprovalCard`, `CardInspection`, the `runs_watched` entries, the `/webhook` response
      envelope) are documented only as exported TypeScript types in
      `sdk/gatekeeper-worker/src/`. A TypeScript consumer reads them; a non-TypeScript OS
      integration has nothing rendered. Worth doing only when such a consumer appears, and then
      preferably generated from the types rather than transcribed.
- [ ] **A `WEBHOOK_SECRET` rotation recipe.** The provisioning-key rotation story is documented
      (a 401 drops the cached key and re-mints once), but rotating the webhook secret is not:
      what order to update the secret and re-enrol in, and what happens to deliveries signed
      with the old secret while the two disagree. Needs verifying against the enrolment and
      verification code before it can be written down honestly.
- [x] **The Cap'n Web framing in the Gatekeeper docs was wrong on one point.** Corrected with
      slice 7, which is when `/rpc` actually became the non-OS door: both READMEs now state the two
      doors and how each is authorized, and `docs/glossary.md` carries the three pairs of words this
      Worker routinely confuses (the two doors, the two approval DIRECTIONS, the two default tiers).
- [ ] **An account maps to a person only inside the workspace.** A minted account id is what rides
      `externalIdentity` onto every key and therefore onto every run, which is exactly the mapping
      slice 3 built, except that the id names nobody outside the OS deployment that holds the stub.
      `AccountDescription.uniqueName` surfaces it so an operator can read it, and that is the whole
      of the affordance today. Closing this properly wants the workspace's own management UI
      (`startAppUi` / `startResourceConfigurator`), which is slice 9 territory at the earliest, and
      is worth doing only once someone has to do the mapping in anger.

## Gotchas the pilot surfaced

- **A health route that assembles is not a health route that checks.** `/health` answered
  `{ ok: true }` off `Gatekeeper.create`, which reads three of the seven bindings, so a Worker with
  no `OS_SHARED_TOKEN` or `WEBHOOK_SECRET` was green while `/rpc` refused every call and the
  receiver verified no delivery. The failure is worse than an absent check, because a monitor keyed
  on it AGREES the deployment is fine. Two rules came out of it: a health check asks the whole
  configuration rather than whatever the request path it borrows happens to read, and it asks in
  ONE pass, because an operator who learns the next unset binding only after redeploying wires a
  deployment one restart at a time. The check is derived from `GatekeeperEnv` through an exhaustive
  `Record`, so a binding this check would silently pass over fails the build instead.
- **A health check may only FAIL on what the deployment asked for.** The correction above has a
  mirror image, and slice 7 walked straight into it: `/health` began refusing whenever the four
  object-model exports were absent, which turned every `/rpc`-only deployment red the moment it
  bumped this package. Both failures are the same one wearing opposite clothes, a monitor saying
  something its operator cannot act on. So the rule is two-sided: a check asks about EVERYTHING,
  and it fails only on what makes the deployment's OWN doors refuse. What is optional is reported
  beside the status (`os: { discoverable, blockers }`) with a reason per cause and its remedy, and
  the operator who wants that door keys a monitor on it.
- **A stub is a LOAN whose term is the call it arrived on.** Workers RPC disposes a parameter stub
  when the method returns, so `startSession(queue)`, which returns immediately and hands back a
  session that uses the queue for the rest of its life, was holding a reference the runtime had
  already torn down. `dup()` takes a reference of one's own and the session releases it when it is
  disposed. Two things follow beyond the fix. Owning a thing means having somewhere to give it
  back, which is what made `[Symbol.dispose]` on the capability the natural home for ending the
  session's pending actions too. And this seam is invisible to the suite by construction: the
  class handed to a workspace is a `DurableObjectClass` only that workspace's machinery can
  instantiate, so what the specs can pin is the shell's `holdQueue`/release PAIR, and the real
  boundary belongs to slice 10's nightly leg.
- **`capnweb`'s `RpcTarget` IS the runtime's, inside workerd.** It reads like a bug that a session
  built on the `capnweb` class crosses NATIVE Workers RPC, which serializes only
  `cloudflare:workers` targets. The library re-exports the runtime's own class rather than
  declaring one, which is what lets a single capability object serve both doors. Stated in
  `capability.ts` because the wrong reading (two base classes, a `DataCloneError` on the first
  bind) is the more obvious one and costs a redesign.
- **"Set it in wrangler.toml or with `wrangler secret put`" is a refusal that leaks credentials.**
  Offered both mechanisms, an operator picks the one that is a file, and the file is committed. The
  mechanism each binding takes is now a fact stated once (`BINDING_KINDS`) and cited by both
  READMEs, which had independently drifted into telling operators that the three secrets live in
  `wrangler.toml`: a documentation error whose worst case is an `admin` API key in a git history.
- **"Card type" and "decision kind" are two vocabularies, and neither maps onto the other.** A
  `decision_required` notification can be an approval gate or an agent question; `merge_review` maps
  to no `/runs/:runId/decisions` entry at all; a run that parked twice is holding the SECOND park by
  the time anyone opens the first card. So the notification type may drive what is SUBSCRIBED and
  what an inbox renders, and must never drive what an answer posts. That comes from re-reading the
  run, every time.
- **A run can hold TWO parks at once.** A follow-up triage accrues while the step still runs, so it
  can be pending under a later step's approval gate. The decision list is in a shape order, not a
  priority order, so a consumer that answers `decisions[0]` settles whichever the projection built
  first. Refusing without a named `kind` is the only honest option.
- **`parked: false` does not mean "nothing to answer".** The follow-ups park is listed whenever any
  item is `pending`, which is deliberately before the run stops. A predicate keyed on the run's
  status misses every early triage, which is the case the surface added it for.

- **A task with only a TITLE parks before any agent runs, and that is the first thing the live leg
  found.** The pre-dispatch input gate is a deterministic reduction over the task's own authored
  fields, so `tasks_create` + `tasks_start` with no description stops on an `input-gate` park
  (`description_missing`) rather than on the step the caller was waiting for. It is correct
  behaviour and no scripted origin can show it: an integration that files work on a title alone gets
  a parked run every time, and reports it as the platform being slow. A Gatekeeper's own docs should
  say what filing a task actually takes; the live specs file one with a description for the same
  reason.
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
- **A Cap'n Web stub intercepts EVERY property, `.call` included.** `method.call(target, args)` on
  a stub does not invoke `Function.prototype.call`; it asks the far side for an operation named
  `tasks_get.call`, and the failure reads like a client-side bug in the caller's own helper. Invoke
  a stub's method directly. The same rule is why a capability's state lives in a CLOSURE rather
  than on the instance: own properties of an RpcTarget are refused outright, so a method installed
  as an instance field is unreachable while looking present in the source. And the same rule decides what a
  DEFENSIVE check can be worth: since a stub answers every property, `typeof stub.onApprovalCard`
  is not a question about the far side, so an absent-method guard can only ever catch the
  in-process case. Write it for that (a plain object deserves the better message), invoke directly
  otherwise, and let the far side report what it does not implement.
- **`@cloudflare/vitest-pool-workers` declares `cloudflare:test` under its `./types` export, not
  its main one.** `"types": ["@cloudflare/vitest-pool-workers"]` in a tsconfig resolves the POOL's
  types and leaves `cloudflare:test` unresolvable; the module declaration arrives through a
  `/// <reference types="@cloudflare/vitest-pool-workers/types" />` in a `test/env.d.ts`, which is
  also where the Worker's own `Env` is merged onto the ambient `Cloudflare.Env`. The Worker
  runtime's `test/env.d.ts` is the model; a new workerd-tested package needs its own.
- **`contract.minScope` is enforcement, not just documentation**, wherever a controller
  references it. Lowering an annotation lowers the gate. Treat a `minScope` diff in review
  exactly like a permission change, because it is one.

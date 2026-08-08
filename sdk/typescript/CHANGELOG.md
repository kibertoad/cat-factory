# @cat-factory/sdk

## 0.28.0

### Minor Changes

- faddbf5: Public API (`/api/v1`, spec 1.34.0): serve a service's in-repo specification. Additive.

  One new operation, `GET /api/v1/services/:serviceId/spec` at `read` scope: the prescriptive
  requirement tree stored under `spec/` in the service's repository (modules → feature groups →
  requirement items, each with its MoSCoW priority, its `aspirational`/`established` state and its
  Given/When/Then acceptance criteria, plus the domain rules scoped to each group), the Gherkin
  rendered from the same tree, and the branch and commit both were read at.

  It closes a join, not just a gap. The requirement ids on `GET /api/v1/runs/:runId/report` and
  `.../outcome` were already a key onto a document no headless caller could fetch, so an
  outcome-reviewing integration could read what a run scored and not what it scored against. Fetch the
  spec once per service and a run's outcome per run, and criterion → evidence is a map lookup outside
  the platform.

  **The read has several outcomes and the endpoint keeps them apart.** The reader behind it is total (a
  flaky repository read degrades rather than throwing), and the app's own requirements window folds an
  unreadable repository into the same empty state as a repository with no spec, which is right for a
  window and wrong for an integrator: folded here it would report every service as requirement-free
  for the duration of a VCS incident. So the response carries a three-valued `anchor` rather than a
  boolean: `absent` (no spec on the default branch) is the only value that means the service declares
  nothing, and `unparsed` says the anchor file is there and corrupt, which is a repository somebody
  has to fix rather than a service with nothing to say. An unreadable repository is a `503` with
  `reason: "spec_read_failed"`; a branch that would not resolve is a `503` with
  `reason: "spec_ref_unresolved"` (a renamed, transferred or deleted repository, a stale default
  branch and a lost installation all answer 404 exactly as an absent file does, so an empty read with
  an unresolved ref is refused rather than served as a confident "no requirements"); an unwired or
  unconnected VCS integration is a `503` with `reason: "vcs_not_configured"`; a service frame with no
  linked repository is the same `422` that starting a run on it gets; and a spec that read PARTIALLY
  is served, with `issues` naming every file that did not survive and how many items a salvaged group
  lost.

  **Every axis of the response is bounded and every bound is reported**, including the two that grow
  outside the spec's control: the Gherkin is capped across all files as well as within each one, and
  `issues` (which grows with FAILURE rather than with the spec) is capped too, so a rate-limit window
  part-way through a large walk cannot make the report of a degraded read the largest thing in the
  response. A `dropped` of `null` on an issue row means content was lost there and no count describes
  it, which is the honest answer for a shard whose `requirements` is not a list at all: those
  requirements are unreadable, so the rebuilt group is served as damaged rather than as one that
  legitimately declares nothing.

  **Two commitments a consumer should read.** `SpecDoc` and everything under it (`SpecModule`,
  `RequirementGroup`, `RequirementItem`, `AcceptanceCriterion`, `DomainRule`) are served as the SAME
  shapes the app consumes rather than a re-projection, deliberately, so one artifact cannot be
  described two ways. From this version they are part of the stable `/api/v1` surface rather than
  internals. And the `spec/` tree is anchored at the repository ROOT, so two services carved out of
  one monorepo share one spec and this endpoint answers both alike; `provenance` names the repository
  and commit rather than a subdirectory, because a subdirectory would imply a scoping the read does
  not apply.

  There is deliberately no write side: the spec's write path is a reviewed commit, and `state` is
  promoted only by an observed test pass.

  Internal, not `/api/v1`: `readServiceSpec` now returns a `diagnostics` field on `ServiceSpecView`
  (`anchor` plus per-file `issues`), so every caller can separate an absent spec from an unread one.
  The field is optional, so a view assembled by hand keeps type-checking, and `EMPTY_SERVICE_SPEC_VIEW`
  carries none. The reader also gained a total READ BUDGET: the tree's size is set by somebody else's
  repository, so one call could previously become an unbounded number of provider round trips, past
  the Cloudflare subrequest ceiling and into the installation's shared rate limit. A walk that stops
  early says so (`unread`), and the run-evidence loader no longer memoises a failed read as the run's
  answer, which had pinned one flaky read onto every later settlement.

## 0.27.0

### Minor Changes

- 8a06abc: SDK clients: a request body with no required field is now a parameter you may OMIT, and
  `POST /api/v1/notifications/:id/act` carries the reviewer-effort tag.

  Fourteen operations have a body whose every field is optional, and until now all four clients
  rendered it as a required positional parameter, so a caller with nothing to say still had to type
  an empty object. That was also what kept `act` body-less: giving it the app's `reviewEffort` field
  would have rewritten `act(id)` as `act(id, body)` in four published clients. Teaching the emitters
  an omittable body fixes both at once, and the emitters read "omittable" off the spec (`required: []`
  on the body schema) rather than a per-operation list.

  `act` now takes `{ "reviewEffort": "none" | "minor" | "major" | null }`, so confirming a merge and
  recording what reviewing it cost is ONE headless request rather than two, matching the app's one-tap
  confirm-and-tag. A `merge_tag_request` card becomes actionable too, but only when a tag is supplied:
  recording one is its entire side-effect, so a bare `act` answers 409 with
  `details.reason: "review_effort_required"` instead of resolving the nudge and writing nothing. The
  route's other 409 now says `no_automated_action`, so the two causes are told apart by a machine.

  **Wire compatibility is unaffected.** `act` mounts `optionalJsonBody`, so an integration that has
  been calling it with no body at all keeps working; every client sends `{}` when the argument is
  omitted, because the route's validator still requires a body to parse.

  **Source compatibility, per language.** TypeScript and Java are unchanged for every existing caller:
  the body gets a default, and Java gets a real overload. Two need a mechanical edit:

  - **Go** takes an all-optional body by pointer, so `Start(ctx, id, body)` becomes
    `Start(ctx, id, &body)` and `Act(ctx, id)` becomes `Act(ctx, id, nil)`. Both are compile errors,
    not silent changes.
  - **Python** makes `timeout` keyword-only on every operation. `act(id, timeout=5)` is unchanged;
    a positional `act(id, 5.0)` is now a `TypeError`. That is the point of the change: leaving it
    positional would have bound `5.0` to the new body and sent the timeout as the payload.

- 8a06abc: Public API (`/api/v1`, spec 1.33.0): the merge-EVIDENCE loop. Additive.

  Four new operations: `GET /api/v1/runs/:runId/merge-record` (the merge decision a run left behind,
  carrying the backend-derived change class, the merger's scores and the preset they were compared
  against), `GET /api/v1/merge-records/rollups` (every change class's accumulated track record as one
  aggregate), `GET /api/v1/merge-records/:recordId`, and
  `POST /api/v1/merge-records/:recordId/effort` (tag or clear the reviewer effort a landed pull
  request needed).

  Until now the merge track record (ADR 0046) was reachable only from a browser session, which split
  the headless story in half: an integration could start a run through `/api/v1` and merge its pull
  request through `POST /notifications/:id/act`, and then had nowhere to record how much review that
  merge took nor any way to read back what the workspace had accumulated. The one signal the
  auto-merge policy is meant to eventually stand on was collectable only by the people who were not
  driving the runs.

  **Tagging is `write`, not `admin`.** `act` is at the top of the ladder because it merges a pull
  request for real; recording how much review an already-landed one took performs no external
  side-effect and merges nothing, so an integration whose job is collecting evidence no longer needs a
  key that can also delete tasks and merge.

  Refusals across the surface carry `error.details.reason`: `run_not_found`, `no_merge_record` (a
  readable run whose pipeline reached no merge decision) and `merge_record_not_found`, which the
  record-addressed READ and the TAG now answer identically, so a client branches on one value
  whichever of the two it called.

  `POST /api/v1/notifications/:id/act` deliberately stays body-less, so the app's one-tap
  confirm-and-tag has no single-request headless equivalent: every SDK emitter renders a request body
  as a required positional parameter, so adding `reviewEffort` there would rewrite `act(id)` as
  `act(id, body)` in four published clients. The headless form is two calls in either order, since the
  tag is idempotent and orthogonal to the decision.

## 0.26.0

### Minor Changes

- 11f9efa: Public API (`/api/v1`, spec 1.32.0): the two cost and telemetry reads that were reachable only
  from a browser session. Both additive.

  `GET /api/v1/usage/spend` groups a board's spend over a window (`24h` / `7d` / `30d` / `90d`) by
  one dimension: `repo`, `ticket` and `run` are the cost-attribution axes an organisation budgets
  against, and `model` / `agentKind` / `service` / `taskType` slice the same money the other ways.
  `GET /api/v1/usage` answers the budget question and structurally cannot answer this one, since the
  ledger row it aggregates carries no board shape and its window is the current calendar month. The
  long windows are served from the durable `spend_days` rollup, which froze each run's attribution
  while the money was being spent, so a quarterly figure does not move when a service is re-pointed
  at a new repository. `source` and `rolledUpThrough` say which store answered and how far its sweep
  has covered, because a rollup that has never run and a board that spent nothing produce the same
  empty breakdown. There is no `workspace` dimension and no account-wide scope: a workspace-scoped
  key must never learn a sibling board's spend. `rows` is the heaviest `limit` slices (default 100,
  ceiling 500) with `truncated` beside it, because `run` and `ticket` grow with activity rather than
  with a catalog; `totals` aggregates the whole window either way, so a capped answer still reports
  what the board spent and loses only the identity of the tail.

  `GET /api/v1/debug/runs/:runId/llm-export` serves a run's model activity as one self-describing
  bundle, the external counterpart of the app's own export button, for a caller assembling the same
  picture from the overview plus a walk of the call list. It differs from the app's export in the
  half that matters: the rollups are SQL aggregates over every recorded call and do not move with
  `limit`, so a bundle budgeted down to a handful of rows still states what the run actually cost,
  where the internal export folds its numbers from the rows it holds and stops pricing them once
  they are a slice. `truncated` and `order` say that the call rows are a window and which end was
  kept, and `available` says whether the deployment retains LLM telemetry at all, since an unwired
  sink and a run that made no model calls otherwise produce the same document and this one is
  composed to be handed straight to a model.

  The SDK emitters gained the notion of a REQUIRED query parameter, which nothing on the surface had
  until now: the TypeScript client no longer defaults such a query bag to `{}` (a signature promising
  a call the deployment refuses), Python emits it with no default, Go and Java say so on the field
  rather than documenting it as optional, and Java withholds both the no-query call overload and the
  record's empty `none()` factory for such an operation, offering `Query.of(<required>)` instead.
  The MCP and gatekeeper facades refuse a missing required query parameter locally, naming it, the
  way a missing path parameter already was: the reference MCP server forwards a host's arguments
  without validating them against the tool's own input schema, so nothing else was catching it.

  `@cat-factory/gatekeeper-bindings` (breaking, pre-1.0): a binding's `queryParams` is now
  `{ name, required }` records rather than bare names, so a credential-holding front-end can refuse
  what the deployment would refuse instead of forwarding it to collect a 400. Bindings that read
  captured run telemetry carry `telemetrySink`, and the new `TELEMETRY_BINDINGS` export is that list,
  derived from the table. It is what a policy should withhold captured model prompts, tool arguments
  and command output with: all of it sits inside a `read` key's floor, and the hand-typed deny list
  it replaces had already fallen behind the surface, leaving the run LLM export readable by an
  oversight tier that denied every sibling read of the same sink. Generation now fails on a `/debug`
  operation that is not classified either way.

## 0.25.0

### Minor Changes

- 3e9a6af: Public API (`/api/v1`, spec 1.31.0): board provisioning, task relationships, and the evidence a
  judging consumer was missing. All additive.

  Seven new operations: `GET /api/v1/repos` and `POST /api/v1/services` (create a service, optionally
  backed by a repository, so a headless deployment can provision the board it drives),
  `POST /api/v1/tasks/:taskId/dependencies` and `.../dependencies/remove` (declare an ordering
  instead of racing a batch of related tasks against one repository), and
  `GET|POST /api/v1/tasks/:taskId/documents` plus `.../documents/detach` (a task's spec routinely
  arrives after the task does). New fields: `autoStartDependents` on the task patch, `dependsOn` and
  `autoStartDependents` on the task projection, `output` and `data` on a run step (an inline-only
  pipeline's deliverable, previously readable only in the app), `truncated` on a run step,
  `linkedElsewhere` on a repo option, and `scope` on a run artifact.

  Two rules a consumer of the new fields should read. **`GET /api/v1/tasks/:taskId/events` serves a
  run's step deliverables REDUCED**: an SSE frame carries the whole run, so an oversized `output` is
  clipped to a preview and an oversized `data` withheld, with `truncated: true` on the step saying so.
  The point read (`GET /api/v1/tasks/:taskId/run`) serves both whole and is what to read for a
  deliverable. And **`GET /api/v1/repos` distinguishes three states, not two**: `serviceId` names the
  service a repository backs ON THIS BOARD, and `linkedElsewhere` marks one already backing a service
  homed on another board of the account, which `POST /api/v1/services` refuses
  (`reason: repo_service_homed_elsewhere`) rather than answering with a frame id a workspace-scoped
  key could not then use.

  One population change worth reading before upgrading: `GET /api/v1/runs/:runId/artifacts` now
  returns the reference designs attached to the run's TASK alongside the artifacts the run captured,
  each row saying which it is. A consumer counting rows to mean "screenshots this run captured" must
  filter on `scope: "run"`; one comparing a screenshot against the design it was judged against
  finally has both.

  BREAKING for a deployment that registers its own polling gate (internal API, not `/api/v1`): a gate
  declares `pollExhaustion` on its REGISTRATION rather than on the `GateDefinition` its factory
  builds. `HUMAN_WAIT_GATE_KINDS` and `BUILTIN_GATE_KINDS` are removed from
  `@cat-factory/contracts` with them. A declaration left on the definition now fails to typecheck
  rather than being silently ignored. The payoff is that public-API admission reads every gate's own
  declaration, so a deployment's unbounded human-wait gate is no longer admitted for a plain `write`
  key and then parked forever with nothing able to name the surface.

  See [ADR 0050](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0050-public-api-headless-completeness.md).

## 0.24.0

### Minor Changes

- 17687a1: Let a headless provisioner say who a key acts for, and carry that onto the runs the key starts

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

  A run's identity is not readable by every key. A key that carries an `externalIdentity` of its own
  sees the value only on the runs started for that identity; a key with none (the provisioner, or
  one a member minted in the app) sees every run's. Without the rule, the one-key-per-person
  deployment this feature is built for would hand each person's key the roster of everyone else, and
  the value is routinely an email. The run projections carry `externalIdentityWithheld` beside the
  value so a withholding is STATED: `null` already means "this run names nobody", and reporting a
  mapping the platform holds as one it never had is the failure the flag exists to prevent.

  Two smaller calls: the identity is never inherited from the provisioning key, since a provisioner
  mints for many identities and naming itself would attribute every run to the integration; and the
  field is offered on the headless mint only, because the session-authed create already records
  `createdByUserId`, an account the platform can resolve.

  The validation splits along what can be PUBLISHED. The shipped `pattern` refuses the C0 controls,
  DEL and the C1 controls, spelled with `\xHH` escapes because that is the one syntax ECMA-262, RE2,
  PCRE, Python and Java all read: the `\uHHHH` spelling this started with is a parse error in RE2 and
  PCRE, so it would have broken the Go client outright rather than rejected a value. U+2028 and
  U+2029 have no portable spelling at all and are refused off the schema, which makes the published
  pattern a necessary condition rather than a sufficient one.

  Additive on the public surface: one optional request field, one nullable field plus its
  withheld flag on the run projections, `null` being the correct answer for every key and run that
  predates it. New nullable `external_identity` column on both stores (D1 0086, Drizzle). OpenAPI
  `info.version` goes to 1.30.0 (1.29.0 was published by the dispatch-diagnostics change while this
  branch was in flight).

## 0.23.0

### Minor Changes

- 01bb6d2: Keep the cause of a failed dispatch and a dead durable driver, instead of discarding it at the
  moment it becomes the only thing anyone wants.

  Three sites had the same shape: the record of a failure was written by the thing that only exists
  once the failure did not happen.

  A run's `diagnostics.lastDispatch` was stamped from the job HANDLE, which `startJob` returns only
  after a container has accepted the job. So the two failure classes the block exists to explain, a
  container that never started and a preflight rejection like "GitHub not connected", were exactly
  the ones that recorded nothing. The block is now opened before the dispatch from what is already
  known and refined afterwards by what only the accepted dispatch resolved, and it carries the
  dispatch's own failure verdict, which the step also holds but loses to the next retry. Inline
  steps stamp one too, naming their backend `inline`: dispatching nowhere is why they stamped
  nothing, and the result was a mixed pipeline reporting whatever container step ran last as where
  the run was when it died.

  The Cloudflare stale-run sweeper answered "the instance was lost, re-create it" for both of its
  swallowed error paths, so a Workflows API outage read as every stale run losing its instance at
  once and re-drove the fleet with no log line to say why. The lookup now returns a probe over four
  states, and the fourth is the point: an instance it could not classify produces no action at all.
  Every action the sweep has is destructive against a run that is actually fine, so one unclassified
  tick costs a run some recovery latency where a guess costs it its container. Two states were also
  reaching the finalize branch by fall-through, Workflows' own `unknown` status and an instance
  finishing its work before pausing, and a terminal instance's own error, destructured by nobody,
  now reaches the stop reason that until now said only that some driver ended without finalizing
  something. An unconfigured workflow binding says so once per isolate rather than reporting the
  kind as healthy forever.

  The local pooled container poll now passes `postMortem`, the same argument the per-run poll always
  did, so a pool member that dies mid-run leaves its exit state and log tail behind rather than the
  bare eviction sentinel.

  Additive on the public API (`info.version` 1.29.0): `diagnostics.lastDispatch` grows an optional
  `failure` object and `executionBackend` one further value. What does change for a consumer is the
  population, since a pure-inline run used to answer no diagnostics at all and now answers a block.
  A new `sweep.run_state_unknown` operational counter reports what the sweeper could not classify,
  which is the one signal that separates a blind sweeper from a healthy one.

## 0.22.0

### Minor Changes

- eaab22a: Register several NAMED outbound webhooks per workspace, instead of one that each integration overwrites

  `/api/v1/notification-webhook` was one endpoint per workspace, which made a second integration's
  enrolment a destructive act: registering it replaced whatever was already there, and the only symptom
  was that the previous receiver went quiet. `GET /api/v1/notification-webhooks` plus
  `GET|PUT|DELETE /api/v1/notification-webhooks/:webhookId` are the additive fix. The singular routes
  keep working unchanged and now address the reserved id `default`, which appears in the collection
  like any other entry, so the two surfaces are two views of one store rather than two stores.

  The endpoint id is CALLER-CHOSEN and `PUT` is idempotent by it. That is what the motivating consumer
  needs (a credential-holding front-end, the Cloudflare OS gatekeeper of
  `docs/initiatives/cloudflare-os-gatekeeper.md`): a Worker booting cold writes its own well-known id
  and is enrolled, whether or not it has ever run, with no id table of its own and no
  create-or-discover round trip it might be racing a second instance on. A server-minted id would have
  pushed exactly that state back onto the caller.

  Each endpoint carries its own sealed signing secret and its own three filters, and every rule the
  singular routes enforce holds identically: the `admin` floor, keep-on-omit in every field, the
  write-only secret, the SSRF guard at the write boundary and per redirect hop. Deliveries FAN OUT to
  every subscribed endpoint, concurrently but BOUNDED at six in flight, isolated per endpoint, and
  sharing ONE wall-clock budget. All three are deliberate: the caller awaits the fan-out on a run's
  terminal path, so serial delivery would make enrolling a second integration a latency cost on every
  run; six is the Workers ceiling on simultaneous connections, past which a `fetch` queues invisibly
  while the delivery's clock runs, so an unbounded fan-out reports failures it never attempted; and a
  shared failure path would let one permanently broken receiver mask every sibling's health. An
  endpoint the budget never reached is reported as not attempted rather than as a delivery failure.
  `deliveryId` is unchanged and carries no endpoint segment, because each receiver only ever sees its
  own copy.

  Watch for two things in review. `notification_webhooks` is re-keyed to `(workspace_id, id)` on both
  stores, and neither generator produces a migration that survives existing rows: the D1 side is the
  usual SQLite rebuild, and drizzle-kit's in-place `ALTER` adds `name` as `NOT NULL` with no default,
  so both are hand-healed (add nullable, backfill to `default` / `Default`, then constrain). And the
  per-workspace cap of 10 is a 409 `webhook_limit_reached` that bounds only what CREATES an endpoint,
  since disabling and deleting are the actions an operator at the cap needs. The cap is enforced in
  the STORE, because counting in the service and writing a statement later admits two racing
  enrolments, which is the access pattern this exists for: D1 gets it from one conditional upsert,
  Postgres from a transaction-scoped advisory lock per workspace.

  Additive on the public surface throughout: four new operations, and two new response fields (`id`,
  `name`) on a projection consumers already tolerate unknown members of. OpenAPI `info.version` goes to
  1.25.0 and all four SDK clients, the MCP facade and the gatekeeper bindings pick the operations up
  from the same generation pass.

## 0.21.0

### Minor Changes

- 74ea2bc: Record which revision of a linked design a run actually built against.

  The dispatch-time freshness check already computed the verdict and rendered it into the agent's
  context, where it did its job and vanished with the container. So "did this run build from the
  revision the designer is looking at" was answerable only while the run was live, and only by
  re-probing the source, which by then answers about the revision it is at NOW. On a design under
  active iteration that is exactly the wrong answer: a reviewer cannot tell an implementation that
  MISREAD the design from one that faithfully implemented a revision the designer has since moved
  past, and the two need opposite reactions.

  Each dispatch now records the documents it put in front of its agent, with the verdict it reached
  about each, on `step.contextDocuments`. The PR verification report gains a `Context sources`
  section composed from those records, and the in-app run outcome card gains the matching "Built
  from" list; both reduce the same records the same way, so the page a person reads and the report
  a reviewer reads cannot disagree.

  The write goes through the existing `StepObservations` seam rather than a call at each dispatch
  site, which is what makes it correct: `buildContext` has two callers that resolve a full context
  and start no job (the over-budget exemption probe, and a re-attach to a job a replayed dispatch
  already started), so a source that recovered in between would otherwise overwrite the revision the
  shipped job actually read with one it never saw.

  A moved revision is DERIVED, not recorded. A row carries the last verdict, since that is the state
  the run ended on, and that alone says the run ended current while saying nothing about the coder
  step that finished before the edit landed. So both readers compute `movedDuringRun` from the
  distinct revisions the run's own steps recorded and state it beside the revision rather than folded
  into it.

  Additive on the public surface: `PR_VERIFICATION_REPORT_VERSION` steps to 9, `RUN_OUTCOME_VERSION`
  to 2, and the API to 1.27.0. `GET /api/v1/runs/:runId/outcome` grows a `sources` section beside the
  existing ones and `GET /api/v1/runs/:runId/report` a `context` one; every section a consumer
  already reads is byte-for-byte unchanged, and the four SDKs plus the MCP facade are regenerated
  from the spec.

## 0.20.0

### Minor Changes

- 1c8df4a: Record what the agent's CLI said about the tool servers it loaded, beside what the dispatch decided

  A step's tool-server record has answered one question since it landed: what the platform wired for
  the agent, and what it withheld and why. It cannot answer the other one. A server that passes every
  check, resolves its credential, survives the budget and reaches the container can still fail to come
  up there: a vendor endpoint that 500s, a pinned `npx` package that no longer resolves, a token the
  vendor revoked between dispatch and launch. In every one of those the prompt promises the agent a
  tool that never exists, and the only evidence was the agent mentioning it in prose, if it noticed.

  The claude-code CLI announces its resolved session before its first model call, naming the MCP
  servers it loaded with a status each, plus the flat list of tools it will expose. The harness reads
  that one event and publishes it on the job view; the engine folds it onto the same
  `step.toolServers` record the dispatch wrote, and the step detail renders it on the existing chips.
  Both halves are kept, never merged into one status: the platform withholding a tool and the CLI
  failing to start one are different faults for different people.

  The distinctions this is built out of are the whole point, because each one reads as a healthy
  server if it collapses:

  - **Not observed is not "nothing was loaded."** Codex's CLI publishes no such report, nor does any
    image older than this one, nor a runner pool whose manifest does not map the field. All of them
    leave the record's observed half ABSENT, and the surface then says nothing at all rather than
    accusing every wired server on every deployment one release behind.
  - **Started-with-no-tools is not started.** A server that connects and exposes nothing reaches the
    agent exactly like one that was never wired, and every other signal about it says healthy, so a
    zero tool count gets its own sentence and an uncounted one stays absent.
  - **A status this build cannot map is not a fault.** The CLI's status words are a third party's
    vocabulary; an unrecognised one records as `unknown` and is rendered neutrally, because painting
    it red would send an operator to debug a working integration each time a CLI adds a word.

  Nothing branches on an observation: this is evidence for a person, not a control signal.
  Correspondingly it rides all three poll dispositions rather than just the live one — a job short
  enough to settle between two polls is never seen running, and a job that fails is the one whose
  post-mortem needs this most.

  Runner-pool operators who proxy the executor-harness verbatim gain
  `response.toolServersPath` on the manifest; leaving it unset costs the diagnostic and never
  produces a false one. Ships with runner image 1.95.0.

  On the public surface this is one additive optional field, `observed` on a step's `toolServers` in
  `GET /api/v1/debug/runs/:runId` (spec `1.24.0`), so a consumer written against the previous version
  parses everything it already knew. The one rule it has to carry across is the first distinction
  above: an absent `observed` is "no observation was made", never "the CLI loaded nothing".

## 0.19.0

### Minor Changes

- e5f7eb0: Serve the run outcome summary over `/api/v1`, and compose it from the same code as the PR
  verification report.

  `GET /api/v1/runs/:runId/outcome` answers the summary the app's outcome card renders: what the run
  changed and what backs that up, for a reader who will not open a diff. It is the report's sibling on
  the evidence surface, not a projection of it.

  Serving it moved `composeRunOutcome` out of the SPA into `@cat-factory/contracts`, and moved the
  rules it shares with the verification report (which tester steps count, the spec join, the
  regression rule, the tallies) into `contracts/src/run-evidence.ts`, where both reductions call them.

  **Behaviour change, and the reason for the whole change.** The two reductions had drifted. The
  report unions every tester step's verdicts and counts coverage over the service's in-repo `spec/`;
  the outcome summary read only the last tester that reported and counted over the verdicts that
  tester happened to return. One run produced different `met` / `not covered` / `total` numbers
  depending on whether you read the pull request or the app. The summary now follows the report's
  semantics on both axes, so a requirement nobody looked at is reported as unchecked instead of being
  invisible.

  **Second behaviour change: the app's outcome card now joins against the spec on the RUN's branch.**
  It fetched the enclosing service's spec from the repo's default branch, so while a pull request was
  open every verdict naming a requirement the run itself added joined against a spec that does not
  carry it yet and rendered as "not checked", and the card's counts then contradicted the endpoint,
  which reads the run's branch. `GET /workspaces/:ws/executions/:executionId/spec` serves the card the
  same read, through the same loader and the same branch rule.

  Additive on the public surface (OpenAPI `1.22.0`): the new endpoint, plus
  `requirements.unmatchedVerdicts` on the verification report, which counts tester verdicts against
  ids the spec does not carry. Those used to be dropped silently, which made the section report fewer
  rulings than the tester made with nothing to explain the gap. The report now RENDERS that count in
  its prose rather than only carrying it in the JSON, and a spec that declares no requirements while
  the tester did return verdicts is reported (0 requirements, every verdict unmatched) instead of
  being called an absence, on both documents: it is a spec that moved under the run, and calling it
  "nothing to rule on" discarded every ruling the tester made.

  The outcome payload also gains `truncations`, in the verification report's own vocabulary. Served
  over `/api/v1` it is scrubbed with `redactSecrets` and bounded, which the report has always done for
  the same tester text on its way onto a pull request; unbounded, its size was set by how much a model
  chose to write. The counts are computed before any cap, so a bounded response still reports the true
  totals. The SPA composes the same reduction locally and caps nothing, so `truncations` is empty
  there.

  Internally: `TESTER_AGENT_KIND` and `isTesterKind` are now defined in `@cat-factory/contracts` and
  re-exported by `@cat-factory/agents` and the engine (the SPA had a hand-written copy with the slugs
  as literals), and the block + `spec/` reads both documents need are shared through a new
  `RunEvidenceLoader`. The outcome summary's `spec` join vocabulary loses `unmatched` (a joined
  section now carries every spec requirement, so a titleless row inside one cannot occur) and gains a
  `no_requirements` gap.

### Patch Changes

- 1025674: Publish each `/api/v1` operation's key-scope floor, and ship it as a policy table.

  Every public route contract now declares `minScope` (`withMinScope`), the controllers enforce
  that same field instead of per-route literals, and the OpenAPI document stamps it as
  `x-min-scope` per operation, beside the `x-public-api-scopes` ladder those floors rank against
  (spec 1.23.0, additive). A new generated package,
  `@cat-factory/gatekeeper-bindings` (`sdk/gatekeeper`), projects the whole surface as a
  policy-annotated operation table (scope floors, mutation and transport metadata, invoke thunks
  over `@cat-factory/sdk`) for credential-holding front-ends such as a Cloudflare OS Gatekeeper.
  Its ladder helpers refuse a scope rung the package does not carry rather than ranking it below
  everything, and `resolveConsequence` applies the cautious reading of an unannotated mutation.
  First slice of `docs/initiatives/cloudflare-os-gatekeeper.md`.

## 0.18.1

### Patch Changes

- f7882cf: Stop the run-debug surface and the decision-list description from telling callers things that are
  no longer true.

  The `tool_retry_loop` signal handed the reader `?ok=false`, a tool-call filter replaced by
  `?outcome=error`. An unknown query param is ignored rather than refused, so the link answered with
  the run's WHOLE trajectory and a follower reading it as the failing subset saw every call as a
  failure. Now pinned by a test, which is what was missing when the param was renamed.

  `listPublicRunDecisions` described two decision kinds out of the thirteen the response can carry,
  and claimed `parked` gates the list. It does not: a `follow-ups` entry is answerable while the run
  is still working, so a caller that polls only when `parked` waits for a stop that never comes. The
  regenerated description names every kind and points an empty `decisions` at `unanswerable`. It
  reaches the spec, the four SDK clients and the MCP tool descriptions, which is the surface LLM
  callers read instead of the docs.

## 0.18.0

### Minor Changes

- 11a2966: Say which tool servers a step actually had, on the step

  A run whose agent kind declares MCP tool servers could drop any of them for seven different
  reasons, and until now every one of those was stated in two places nobody looks: the agent's own
  system prompt, and one backend `warn` line. From the outside a run that quietly went without its
  issue tracker was indistinguishable from a run whose agent simply chose not to use it, which is the
  question an adopting deployment asks first and the platform could not answer.

  **A dispatch now records what it decided on the step** (`PipelineStep.toolServers`): the servers it
  wired (id, label, transport, and the narrowed `allowedTools` where the definition set one), the ones
  it dropped each with its reason, and the agent kind those lists belong to. The step detail renders
  them as chips, with translated copy per reason in every locale, and hides itself when the record
  holds nothing (a kind that declares no tool servers, which is every step on a deployment that
  registers none).

  The kind is stamped by the engine as it folds, from the same parameter that feeds `step.dispatches`,
  because a step's own kind is routinely not what ran: a `ci` gate escalates to `ci-fixer`, a tester
  hands off to `fixer`, a two-phase coder dispatches twice. Each of those resolves its own
  declarations and overwrites the record, so without the stamp the chips would credit one agent's
  capabilities to another. The step detail names whose they are whenever the two differ.

  **Recorded on the STEP rather than on the agent-context telemetry snapshot**, which is where the
  same facts sat inside an untyped `extras` bag. The snapshot is double-gated behind
  `LLM_RECORD_PROMPTS` and the per-workspace `storeAgentContext`, and pruned on the telemetry
  retention window, so a surface reading it would be blank on any deployment that simply has prompt
  recording off. "Which tools did this step have" is an ordinary question about a run, not an opt-in
  debugging artifact. It also costs no telemetry migration: the run row already carries its steps as
  JSON.

  **Public API (additive, `info.version` 1.21.0):** each step of `GET /api/v1/debug/runs/:runId` now
  carries the same record, so a diagnosing reader can tell "the agent never had the tool" from "the
  agent had it and did not call it", which the tool-call trajectory alone cannot show. The snapshot's
  `extras.toolServers` / `extras.unavailableToolServers` keep being served, deprecated, projected from
  the step's own record so the two cannot disagree; the removal window is in `backend/docs/public-api.md`.

  It is written at dispatch and never re-derived, for the same reason the model and the leased
  subscription token are: the poll site rebuilds the job handle from the step alone, and whether a
  server was servable depended on the resolved harness plus the facade's secret and OAuth resolvers at
  that moment. A workspace that fills in a missing credential an hour later must not make a step that
  ran without the tool read as one that had it. Absent and both-lists-empty stay different states:
  absent is "no container dispatch recorded here", both-empty is "a dispatch ran and its kind declared
  none".

  **The unavailability vocabulary moved to `@cat-factory/contracts`, and kernel's
  `UnavailableToolServer['reason']` is now typed against it.** The SPA cannot see kernel, so leaving
  the union there would have made the run surface's copy a hand-written duplicate of a closed list,
  and a member added on one side only renders as a blank chip. Which member a dispatch picks is still
  decided in kernel. Internal break: the seven reason strings are unchanged, but the type now aliases
  `ToolServerUnavailableReason`.

  **Tool servers and capability credentials also gain their first cross-runtime assertions.** The
  conformance harness could not reach either, because the suite runs a `FakeAgentExecutor` that
  composes no job body, and the values are write-only on every wire. `ConformanceApp.toolServerDispatch()`
  (built by `makeToolServerDispatchProbe` over each facade's OWN container) drives the same
  `resolveToolServers` a dispatch does with the chain that facade actually composed, so a facade that
  wired its per-workspace credential store behind the deployment environment (or not at all) now
  fails a test instead of handing its agents an unauthenticated server. It asserts a stored credential
  reaching the job body under its declared channel, an unstored one dropping the server as
  `missing_secret` in the same resolution (the per-KEY composition rule), and a Pi run dropping
  everything as `harness_unsupported`.

  What this does NOT answer is a server that was wired and whose CLI failed to start it anyway: that
  needs the agent CLI's own startup report, which is a harness change and therefore a runner-image
  bump. It is the remaining half of the tracker's slice 5; the probe already diagnoses the same
  condition interactively.

## 0.17.0

### Minor Changes

- 00bff05: A descriptor-driven form groups under section captions

  The last open gap from the extension-seam report an org build filed against the published packages: a
  reusable operation that collects thirteen fields, every one of which changes what the agents do,
  rendered as one undifferentiated column. `DescriptorFields.vue` walked `fields` in declaration order
  and the vocabulary had no grouping attribute, so the only way to signal structure was to bury it in
  each `label`.

  A field may now carry `section`, the caption its run of fields renders under. It sits on the SHARED
  `descriptorFieldEntries` spread, so both declaring surfaces (a custom task type's per-case form and
  an initiative preset's create form) gain it at once and cannot drift, and the gate-config form the
  pipeline builder renders through the same component gets it for free. It is presentation and nothing
  else: validation, what is frozen on the entity, and the prompt fold are all untouched, so moving a
  field between sections can never change what the platform does with its answer.

  The grouping RULE lives in contracts (`descriptorFieldSections`) rather than in the renderer, because
  two readers depend on it. Visibility is applied BEFORE the runs are cut, which is what makes a
  section whose every field is hidden by `showWhen` render no caption at all (a caption over nothing
  reads as a form that failed to load its own controls) and what keeps a hidden field between two
  fields of one section from splitting its caption in half. Two spellings of one caption fold together
  on case and whitespace, exactly as the task-type picker's category rows do, and the first spelling is
  the one rendered, because a caption is the deployment's own words rather than an id.

  Declaration order is never rearranged, and that is what makes the second reader a boot ERROR
  (`task_type_field_section_interleaved` and its `initiative_preset_` / `gate_` siblings, through the
  same `descriptorFormProblems` checker every declaring surface shares). A section a form can be made to
  caption twice has no honest rendering: the caption prints twice, which reads as a platform fault
  rather than as the declaration it is, and the alternative repair moves a field away from where its
  author wrote it. Refusing the declaration at boot is the only disposition that leaves the renderer
  free of a repair nobody asked for, and it is the bar the surrounding checks already hold registrations
  to (error on what is fully knowable from the registration).

  What that check judges is REACHABILITY, never contiguity in the declared list, because the reduction
  it mirrors applies visibility before it cuts the runs. A branching form is written with its branches
  interleaved (each branch's fields beside the picker they qualify), so a section is reported only on
  finding a concrete state that prints it twice: two of its fields with a differently-captioned field
  between them that can be on screen beside both. For the single-condition vocabulary that is decidable
  pairwise, since the only contradictions available are two `equals` on one key and an `equals` against
  an `includes`. Reading contiguity alone would fail a deployment's boot outright over a form no user
  can break, which is a far worse failure than the duplicate caption it is guarding.

  The third surface reaching that checker is new here: a registered GATE's per-step config form
  rendered through the same component, which had none of these checks behind it, so a gate could boot
  clean and print the duplicate caption the platform calls its own fault (along with unchecked duplicate
  keys, optionless pickers and out-of-options defaults). It declares its form as an option on
  `GateRegistry.register` rather than as a field of a descriptor type, which is why nothing at the call
  site read as a descriptor form; the code prefix is now a named union so the next such surface has to
  be added deliberately.

  Reviewing: the interesting question is that severity, since grouping is cosmetic and every other
  error in that checker is a form that cannot be filled. The renderer's own behaviour for an
  interleaved declaration is still defined and total, because it has to be for a wire descriptor from a
  node whose build differs.

  One rendering constraint is worth knowing before touching the component: the captioned runs render
  FLAT, with each run's caption on the field that opens it, never as a per-run wrapper element. Run
  membership shifts as `showWhen` reveals fields while a field's identity does not, so nesting the
  fields inside a wrapper re-parents them when a boundary moves, and Vue can only do that by remounting
  them. The remounted input is the one being typed into, because typing into the trigger is what moved
  the boundary.

  `section` reaches `/api/v1` through `GET /api/v1/task-types`, so the surface version steps to
  `1.20.0` and the SDKs are regenerated. Additive per ADR 0034: it groups nothing the create call
  validates, so a client that ignores it fills exactly the same bag as before.

  With this the `deployment-extension-seam-gaps` tracker's committed scope is complete, so it converts
  to [ADR 0040](../backend/docs/adr/0040-deployment-extension-seam-reachability.md). The one item that
  does NOT land is the deployment-scoped document source, declined rather than deferred: the account
  tier already serves an org-wide living document, and the boot error added earlier in that initiative
  names that path at the moment a deployment reaches for the wrong one.

## 0.16.0

### Minor Changes

- 4c071ec: Close the last committed gaps in reusable operations: hide one per board, invoke one headlessly.

  Five changes, landed together because the last two turned out to depend on each other: the public
  task-type catalog has to honour suppression (a type it lists and creation then refuses is worse than
  one it omits), and both read the registry through the same projection the board snapshot does.

  - **Per-workspace suppression.** An org registers its operations process-wide, so twenty of them
    flood the picker of a team that runs three. A workspace admin (`settings.manage`) now hides the
    ones that board does not use. Tombstones in a new `task_type_suppressions` table (D1 ⇄ Drizzle,
    with conformance), so ABSENCE is the default and a newly registered operation reaches every board
    until somebody hides it: the only direction whose silent failure is a surplus rather than a
    withheld capability. Three readers, and their failure postures differ on purpose: the board
    snapshot and the public catalog are best-effort (a picker must not take a board load down over a
    cosmetic preference), while `BoardService.addTask` PROPAGATES, because it decides whether a row is
    written and hits the same database as the insert. The creation refusal is what makes the hiding
    real: the internal API, the public API, an initiative spawn and a tracker import all reach
    `addTask` without ever seeing a picker. Built-in types stay unsuppressible (they carry hardcoded
    creation affordances). Mothership bucket: `remote`, because the catalog is code and the hide-list
    is data.

  - **Public API: discover a form, then fill it.** `/api/v1` could always NAME a task type and fill
    none of it, so a headless caller filed an operation and every agent in the run worked from a blank
    form. `GET /api/v1/task-types` (`read`) serves the built-in types plus this workspace's registered,
    non-suppressed ones with the fields each accepts; `fields` on task creation fills them, landing in
    `taskTypeFields.custom` for a custom type and on the schema-typed top-level keys for a built-in
    one, so existing creation machinery runs unchanged. Additive per ADR 0034: OpenAPI `info.version`
    → 1.18.0, SDKs regenerated. One table (`contracts/src/public-task-types.ts`) backs BOTH directions
    rather than the descriptors-plus-hand-written-OpenAPI-shape the design sketched, so what discovery
    advertises is exactly what creation validates, through the shared `validateDescriptorFields` the
    app's own form runs. Refusal is a 422 with `details.reason: 'task_type_fields_invalid'` carrying
    every problem at once.

  - **Descriptor defaults apply at the door, not in the form.** `withDescriptorFieldDefaults` runs
    server-side at both descriptor doors (a custom type's creation bag and an initiative preset's
    inputs) before validate + sanitize. A field that is both `required` and defaulted was accepted
    from the SPA (which had already seeded it) and refused for every other caller, which had no way
    to know it must restate a value the deployment already declared. The SPA now seeds from the same
    shared helper rather than its own copy. Consequence worth naming: because defaults are
    authoritative, a `select` default outside its own options is now a boot ERROR
    (`task_type_field_default_outside_options`) instead of a form that merely opened oddly.

  - **The new-pipeline advisory names a pipeline instead of humanising its id.** `pipelineCatalogNames`
    rides beside `pipelineCatalogVersions`, built from the same `seedPipelines()` read so the two
    cannot list different ids. Humanising was fine for shipped built-ins and wrong the moment a
    deployment registered its own: `pl_org_introduce_api` was offered as "org introduce api", on
    exactly the boards that predate an operation and therefore see this advisory.

  - **The Go SDK client's accessor list was three groups stale.** `me`, `evidence` and `keys`
    generated services that nothing constructed, so those endpoints were uncallable from Go while
    every drift check passed. All are wired, and `check-sdks.mjs` now fails on a resource group Go's
    hand-written client never constructs. Two emitters had the sibling latent bug: group names are
    camelCase in the surface table and every group was one word until `taskTypes`, so Python now
    snake-cases them (`client.task_types`) and so does the MCP facade, whose tool name and group are
    the strings a HOST allow-lists and a model calls (`task_types_list`, and `task_types` in
    `CAT_FACTORY_MCP_GROUPS`). A NEW resource group, as opposed to a new operation, is what exercises
    those paths.

  Breaks, all internal and unreleased: `CoreDependencies` and `BoardServiceDependencies` gain an
  optional `taskTypeSuppressionRepository`; `snapshotRegistryProjections` takes an optional workspace
  id (absent at workspace-create, which cannot have hidden anything); `PublicTaskCreationDeps` gains
  `taskTypeRegistry`; the snapshot gains `suppressedTaskTypes`; the Python SDK's and the MCP
  facade's multi-word resource names are now snake_case.

## 0.15.0

### Minor Changes

- 53cd697: Close three holes in `/api/v1` around a run that stops.

  - **A bug-triage question is now answerable from the ticket it was asked on.** The clarity gate's
    park echo rendered its findings as bare prose, so the ticket-comment reply grammar (which
    addresses a finding by id) could never reach it. Both review subjects now ride one id-carrying
    post path, and a comment naming a clarity finding drives the clarity review through the same
    service methods the app calls.
  - **`decisions: []` no longer means "we cannot say".** The decision list carries `unanswerable[]`,
    naming each wait this surface cannot answer — a human-review gate, a gate the deployment
    registered itself, an interviewer wired nowhere — with where its answer actually lives. It lists
    only waits that are live and genuinely beyond this surface: a finished run names nothing, and a
    wait the same response answers (a deployment gate that exhausted onto an ordinary approval) is
    never reported as one nobody here can answer.
  - **`GET /api/v1/me`** reports what the calling key may do, and **`GET /api/v1/openapi.json`**
    serves the deployment's own spec.

  Internal break: `IssueWritebackProvider.postQuestions` is gone (folded into `postReviewQuestions`,
  which now takes a subject), and `TrackerWebhookService` takes `reviewGateways` per subject in place
  of the single `reviewGateway`.

## 0.14.0

### Minor Changes

- 7f5ed08: Aggregate tool-execution failures: a rollup, a signal and an `?ok=` filter

  A failed tool call was a row nowhere counted. The trajectory sink recorded each one (`ok: false`,
  with what the tool returned), and nothing above it added them up: the run overview reported only how
  many tool calls the run made, no filter narrowed a page to the failures, and no signal was derived
  from them. That is the one class of failure the LLM telemetry beside it structurally cannot see: a
  rejected edit or a non-zero command is a perfectly healthy model call whose result came back bad, so
  a run stuck re-running a broken tool reports a clean model side and an inexplicable death. Finding
  it meant paging the whole trajectory and reading each row's `ok` by eye.

  `AgentToolCallRepository.summarizeByExecution` is now the one GROUP BY, at the `(agentKind, tool)`
  grain, and it REPLACES the bare `countByExecution`: the overview's `sinks.toolCalls.count`, its new
  `toolCalls` rollup and both of that rollup's breakdowns are folds over the same cells, so a count and
  a breakdown that disagree is not a representable state. The grain keeps both halves deliberately,
  because the finding is the CONCENTRATION: one agent kind retrying one tool is a stuck loop, the same
  count scattered over nine tools is an agent exploring, and either axis alone folds that away. Every
  level carries `failureRate` beside its counts (34 of 36 and 34 of 3,600 are the same number and
  opposite diagnoses) and a run that called no tools reports it as `null` rather than a clean 0%, which
  would file "nothing happened" beside "everything worked".

  Two signals ride it, and their severities carry the difference between them. `tool_calls_failed` is
  an `info` reporting the run-wide count with its ratio: a failing tool call is the ordinary shape of
  an agent loop (a test that fails before it is fixed, a `grep` that matches nothing), so as a warning
  it would fire on most healthy runs and cost the severity ordering the thing it is for.
  `tool_retry_loop` is the `warning`, firing only where the failures concentrate on one
  `(agentKind, tool)` cell that is both mostly-failing and has failed enough times to not be a single
  bad command. It selects among the cells that QUALIFY rather than testing the run's most-failed one,
  which is not the same thing: ranking first would hide a fixer wedged 5-for-5 on `apply_patch` behind
  a coder's 6 failures across 100 healthy `bash` calls, silently missing the run the sink exists for.
  `failure_outside_model_calls` now reads the sink before deciding where to send the reader: failing
  tool calls to start at, a recorded loop with none in it (so what is left is the engine), or no
  trajectory at all — which is unrecorded rather than uneventful, and was previously indistinguishable
  from a clean one.

  Public API 1.12.0 → 1.13.0, additive: `?ok=true|false` on `GET /api/v1/debug/runs/:runId/tool-calls`
  (both orders, applied in SQL, because a caller filtering a page itself has already spent that page's
  `limit` on the calls that worked) and the `toolCalls` block on the run overview. The four SDK clients
  and the MCP facade are regenerated. Worth a reviewer's attention: `countByExecution` is gone from the
  kernel port, so all three telemetry stores, the mothership read-through and its bounded-read table
  move together, and the new aggregate is classified `telemetry` in the drift guard rather than routed
  over the persistence RPC.

  No migration, and the aggregate is knowingly costlier than the COUNT it replaces: the existing run
  index served that count without touching the table, while grouping reads `agent_kind`, `tool` and
  `ok` off each row. A covering index would buy that back and is the wrong trade here: this sink is
  append-hot (a row per tool call of every run) and the aggregate runs once per debug overview, so a
  fifth index would tax the hot path for the rare read. Either way the scan is bounded by one run's
  rows.

## 0.13.0

### Minor Changes

- bac6776: Follow-up triage and interview-gate decisions over the public API

  `/api/v1` answered every park a pipeline can carry except three. Two of those were surfaces nobody
  had built (`docs/initiatives/public-api-additions.md` found them while landing the rest, and left
  them unranked); this lands both, leaving `human-review` as the only ❌ row, and that one is
  unanswerable by construction, since its answer is a person approving the pull request on the VCS
  host rather than an API call.

  **Follow-up triage** (`…/decisions/follow-ups/items/:itemId/{file,send-back,answer,dismiss}`) is the
  first decision here that is not a park: the Coder streams forward-looking items while it is still
  running, so the projection lists them whenever any item is `pending` rather than once the run is
  `blocked`. An integration that triages as they arrive never sees the run stop at all.

  **Interview gates** (`…/decisions/interview/{answer,continue,proceed}`) are ONE route set for every
  interviewer, keyed by run alone: which interviewer is asking is a property of the parked step, so
  the server resolves it and the decision's `stepKind` reports it. That needed a new seam: the two
  built-in gates store their Q&A on entities belonging to their own features, so `InterviewGateKind`
  now projects a kind-neutral `InterviewView` (the questions and the round budget, deliberately not
  the brief each one converges on), reached through the narrow `InterviewGate` interface rather than
  the entity-generic controller. A third interviewer implements `view` and needs no route, projection
  or decision kind of its own; it does still wire its controller, since an interview gate is built
  from its feature's own store rather than constructed by a registry. Registered-but-unwired is a
  real state and reports as one: admission counts the park (it reads the trait), the projection lists
  nothing, and the routes 503 naming the kind. Its question `status` is derived, not stored: one gate
  keeps an explicit `dismissed` marker and the other has only the answer, so one derivation is what
  lets a caller read both through one shape.

  Worth reviewing, because it is a behaviour change rather than an addition: **an interview gate is now
  a park surface the start rule can see**, read off the step kind's `interview-gate` trait. That closes
  a hole in the wrong direction: an interviewer is an INLINE step, so a pipeline built out of
  interview steps satisfied the inline-only rule and was reported `headlessStartable` while every run
  of it stopped on the first batch of questions. No shipped preset changes hands (`pl_initiative` and
  `pl_document` both carry a later human gate and were already admitted as parking on it); what
  changes is that the refusal names the interview, and that a pipeline whose only park is the
  interview is finally refused for a `write` key.

  **Follow-up triage is deliberately NOT added to that rule**, and the trade-off is stated in
  `backend/docs/public-api.md` rather than left to be discovered: the companion is on by default on
  every Coder step, so counting it would make `decide` mandatory for all board work that builds
  anything and take board starts away from every live `write` key at once. The park now has an answer
  path, so a run that stops there is recoverable with a `decide` key instead of being app-only.

  Also noted rather than fixed, in the same three places a reader would look: an unbounded human-wait
  GATE a deployment registers itself is invisible to the start rule, because a gate declares
  `pollExhaustion` on the object its factory builds from an engine context and nothing can read that
  at HTTP request time. Such a pipeline is admitted for a `write` key and then parks with nothing on
  this surface able to name it. The tracker ranks the fix (declare `pollExhaustion` at registration
  and read the registry, which also retires the hand-kept `HUMAN_WAIT_GATE_KINDS` constant) as its own
  slice, since it changes the `GateRegistry` seam.

  Public API surface version `1.10.0`, additive: two new decision kinds (`follow-ups`, `interview`) and
  seven endpoints, all `decide`-scoped.

## 0.12.0

### Minor Changes

- e7867db: Run evidence and key provisioning on `/api/v1`, and a trajectory link on the PR report

  Everything the platform captured about a run was reachable only from a browser session. A consumer
  whose job is to JUDGE a run (a trial harness deciding whether to accept a change, an evaluation
  pipeline scoring a fleet) could scrape the fenced JSON block out of a pull-request body and read
  `/api/v1/debug/*`, and that was all: the captured screenshots were unreachable, and a run with no
  pull request (a headless job, a run that failed before it pushed) had no evidence surface at all.
  Getting a key at all still needed a browser.

  Three additions, all `/api/v1`:

  - **`GET /runs/:runId/report`** serves the engine's verification report: the SAME bundle it writes
    onto the pull request, composed on read by the same code, so the two can never disagree about
    what a run proved. It answers for runs that never opened a pull request, and it does not consult
    the `publishPrVerificationReport` opt-out, which is a statement about writing onto someone else's
    pull request rather than about reading your own evidence back.
  - **`GET /runs/:runId/artifacts`** and **`GET /artifacts/:artifactId/blob`** list a run's captured
    artifacts and stream their bytes, at `read` scope, with the content type clamped to the image
    allow-list exactly as the session-authed route does. An account with no blob backend gets a 503,
    never an empty list. The blob operation declares every media type it can answer with (the image
    allow-list plus an `application/octet-stream` fallback) rather than one standing in for the rest,
    so a client generated from the spec can switch on the response honestly.
  - **`GET|POST|DELETE /keys`** provisions keys headlessly at `admin` scope. Two enforced bounds make
    that safe: a key minted here can never reach the `admin` rung minting requires (so the chain is
    one link long), and revoking a key now revokes every key it minted, on this surface and in the
    app alike. Otherwise a leaked provisioning key would survive its own revocation.

  Refusals across the three evidence reads carry `error.details.reason`, so causes needing different
  reactions stay apart: `run_not_found`, `artifact_not_found`, `artifact_blob_missing` (the row
  outlived its bytes, which is a storage fault rather than a bad request) and
  `binary_artifact_storage_unconfigured`.

  The **PR verification report** gained the links a machine needs: `observability.trajectoryUrl` (the
  run's tool calls in the order the agents made them) and `observability.reportUrl` (this report,
  served live), both rendered in the prose as well as carried in the JSON, and both built from the
  deployment's public BACKEND url. Report payload version 5 → 6.

  Worth knowing when upgrading:

  - **The report shape is now part of the STABLE public surface.** It is served verbatim on
    `/api/v1`, so from here it grows additively and never renames or retypes in place.
  - **A new `created_by_key_id` column** on `public_api_keys` (D1 migration `0081`, its Drizzle
    mirror, plus an index), which carries the provenance of a headless mint and is what the
    revocation cascade follows. The app's key panel renders it, so a provisioned key no longer reads
    as one whose minter is unknown.
  - **The SDK chain learned binary responses.** An operation whose success body was neither JSON nor
    SSE previously generated as a method that returned NOTHING; the IR now marks it `binary`, each
    of the four transports hands the bytes back in its own idiom, and an unrecognised media type
    fails generation instead of silently discarding a body.
  - **A container wiring bug is fixed on both facades**: the HTTP layer's binary-artifact store
    resolver was built from account settings while the engine's came from `CoreDependencies`, so an
    override reached one side of the app and not the other.

## 0.11.0

### Minor Changes

- c5a1a16: Per-step gate configuration: approver policies, approval quorums, and gate-declared settings

  `Pipeline.gates: boolean[]` said a step paused for "a human" and nothing else. There was nowhere to
  say which humans, how many of them, or what a registered gate's own knobs should be for this
  particular step — the built-in gates read their attempt budgets and time windows off the
  workspace-wide merge preset, and a deployment's own gate had nowhere to put its parameters at all.

  A step now carries `stepOptions.gateConfig` (the extensible per-step bag, so no column and no
  migration on either runtime), with two halves. The platform owns `approvers` and `minApprovals`: who
  may resolve the human gate, and how many DISTINCT people must, both snapshotted onto the approval
  when the gate is raised so an edit to the pipeline cannot move the bar under the people already
  counted toward it. The GATE owns `fields`, declared on its registration
  (`register(kind, factory, { configFields })`) as descriptor fields — one declaration driving the
  save-time validation, the run-start re-validation and the authoring form the builder renders, so a
  registered gate needs no frontend change to become configurable. The built-ins declare their own
  (`maxAttempts`, `watchWindowMinutes`, `graceMinutes`) instead of the engine hard-coding them.

  Behaviour changes worth reviewing. The approver policy governs all three resolutions, not just
  approve: a gate the wrong person can reject is not a gate. A workspace admin always passes a policy
  (they can cancel the run or edit the pipeline anyway, and refusing them would deadlock a gate whose
  named approvers have left). A machine key or an auth-disabled caller is refused by any policy — a
  shared credential is not one of the people a policy named — which also means a quorum above one
  cannot be met on a deployment running with auth off, since counting distinct approvals needs
  identities that deployment does not have. All of this is additive: a gate with no config behaves
  byte-for-byte as it did.

  A quorum votes on ONE artifact, so only the approval that CLEARS the gate may carry a `proposal`
  edit. An edit on an earlier approval is refused (`proposal_not_editable_until_quorum`) rather than
  silently rewriting the text under the people already counted toward the bar; the SPA withholds the
  affordance and says why. Both raise sites for the human gate now go through one `buildStepApproval`
  builder, so a gated COMPANION step honours the policy and quorum its step configured.

  Public API (`/api/v1`, surface version now `1.9.0`, additive): the `approval-gate` decision projects
  `requiredApprovals` and `recordedApprovals`, because a quorum makes `approve` legitimately not
  advance the run and without the tally a caller could not tell that from a failed call.

  Internal break, per the pre-1.0 rule: `ExecutionService.approveStep` / `requestStepChanges` /
  `rejectStep` now require a `GateActor`. Required rather than optional so an entry point that forgets
  to supply the acting identity fails to typecheck, instead of silently resolving a gate that names
  its approvers as though it named nobody.

  Design record: `backend/docs/adr/0038-per-step-gate-config.md` (supersedes the
  `extensible-custom-gate-config` initiative tracker, removed).

## 0.10.0

### Minor Changes

- 289b3de: Disposer step, and a teardown that is proved rather than assumed

  A run's PR asserts a three-leg proof — the test environment came up, evidence was captured against
  it, and it was torn down again — and the third leg had two problems.

  Nothing closed it inside the run. Teardown happened only on the TTL sweep, a manual Destroy, a
  `human-test` resolution, or a re-provision supersede. The sweep fires long after the last step
  settled, so the report was published saying the environment was still live and corrected later
  through a back-channel, and only where a provisioning log is retained. TTL is a backstop; it
  cannot be a proof.

  Worse, the teardowns that did happen were never checked. Success was recorded whenever
  `provider.teardown()` returned without throwing, which is a different fact from the environment
  being gone: `HttpEnvironmentProvider` reports `torn_down` unconditionally, so a manifest with no
  `teardown:` request destroys nothing and still reports success, and a Kubernetes namespace
  `DELETE` returns while the namespace is still `Terminating`. The section could therefore render a
  green tick about an environment that was still running and still billing.

  So teardown now has two halves. A new optional `EnvironmentProvider.confirmTeardown` re-probes
  after the destroy call and the result is recorded as its own `teardown-verify` log row; only a
  probe that positively finds the environment gone counts as a reclaim. This is deliberately not
  folded into `status()`, whose implementations are all written to describe a LIVE environment — the
  generic provider with no `status:` template answers `ready` forever, and the compose mapping reads
  an empty project as `failed`, both of which are exactly inverted as teardown verdicts. The four
  outcomes stay distinct because each needs a different person: confirmed, still standing (the
  teardown was a no-op — fix the config and reclaim by hand), unverifiable (the provider has no way
  to tell you, and no retry will change that), and unconfirmed (transient; the next sweep re-probes).

  And a new `disposer` step, the deployer's counterpart, reclaims what the run provisioned wherever
  its author places it — after the automated tester, or after a human has finished with the live
  URL. It never fails the run: it commonly sits after `merger`, so an un-reclaimed environment is a
  recorded warning and an operator's job, not a failed pipeline. It is palette-addable rather than
  seeded into the built-in pipelines; seeding it is a follow-up that needs its own version bumps.

  Crucially it reclaims BY IDENTITY, not by re-resolving. The deployer now records which environment
  each frame got (`deployEnvs[frame].environmentId`) and the disposer tears down exactly that one.
  Re-resolving from `(block, frame)` reads correct and is not: that lookup falls back to the block's
  frame-less row, which is where the manual and `human-test` environments live, so a disposer running
  after a supersede, an operator's Destroy or a TTL sweep on a long run would have destroyed an
  environment the run never provisioned and recorded it as the frame's clean reclaim.

  The provisioning-log operation vocabulary is part of `/api/v1`, so `teardown-verify` is an
  ADDITIVE public-API change: the OpenAPI surface goes to 1.9.0 and the four SDK clients plus the
  MCP facade are regenerated from it. The SDKs tolerate unknown enum values by design, so an older
  client decodes the new row as a plain string rather than failing.

  One ordering detail is worth understanding, because getting it wrong made the whole feature
  unreachable while every unit test still passed. The hook that re-publishes the PR report on a
  teardown fires from the same place that writes the log rows, and its consumer RE-READS that log.
  Fired between the teardown row and the confirmation row it sees a teardown nothing has verified,
  publishes `unconfirmed`, and — being the last edge on an already-settled run — is never corrected.
  Both writes and the notification therefore happen in one method that takes the confirmation, and
  the regression test asserts the row count at hook time rather than the final rows, since only that
  can see the order.

  Two things to watch when reviewing. The report gains a `teardown: 'unconfirmed'` state, and
  because a missing verify row is treated as "not proved" rather than as a pass, runs whose
  teardowns predate this change will report unconfirmed rather than confirmed. That is a correction,
  but a visible one. And the confirmation applies to every teardown path, not just the new step, so
  a deployment whose provider config makes teardown a silent no-op will start being told so.

## 0.9.0

### Minor Changes

- 99be350: Public API: answer every remaining park a run can stop on

  `/api/v1/runs/:runId/decisions` could answer four parks; a `decide` key could START many more than
  that, so a caller could put a run into a state only the app could get it out of. Twenty-four
  additive endpoints close the gap: the generic approval gate (approve / request-changes / reject,
  plus `resolve-exceeded` for a companion at its rework cap), agent-raised decisions, the
  clarity-review and both brainstorm loops, PR deep-review curation, and the two human-verdict gates.
  The decision list gained seven kinds alongside them, and the OpenAPI surface version is now `1.7.0`.

  Of the parks a pipeline can carry, only `human-review` is now unanswerable, and by construction
  rather than omission: its answer is a person approving the pull request on the VCS host. Two park
  surfaces the original investigation missed (follow-up triage, interview gates) are recorded in
  `docs/initiatives/public-api-additions.md` as unbuilt and are NOT advertised as answerable.

  Behaviour change worth reviewing: a park that rides the engine's generic `step.approval` but is
  owned by a dedicated surface (a review gate, a fork choice, a human-verdict gate, follow-up triage,
  an interview) is reported as its own kind, never as `approval-gate`, because the engine refuses the
  generic verbs on those. `StepDecisionController`'s refusal and the public projection now read one
  shared classifier so the two cannot disagree.

## 0.8.0

### Minor Changes

- cec0c3e: Attach spec-sized requirements documents when creating a task over the public API.

  `/api/v1` had no way to give a run a specification. `description` caps at 2,000 characters because
  it is a task's own framing, echoed into every prompt; the 50,000-character `POST /jobs` brief drives
  inline pipelines that never touch a repository; and the app's own attach-a-document flow is
  session-authed. A headless caller holding a PRD could only paste a truncated version of it into a
  field and hope. `POST /api/v1/services/:serviceId/tasks` now takes an ordered `documents` list, each
  entry either NAMING a page in a connected document source (imported and attached, as `ticket`
  already does for a tracker issue) or CARRYING the text itself. The full body reaches agents exactly
  as a document a human attached does: materialised under `.cat-context/` for a container agent,
  folded into the prompt for an inline one.

  Carrying the text needed a document with no source behind it, so `DocumentOrigin` (`DocumentSourceKind`
  plus `upload`) is now what a stored row and its block/role links are keyed by, while everything a
  provider does stays typed against the narrow union. That keeps the missing `upload` provider a
  compile error rather than an `undefined` at whichever call site reaches for it first. An uploaded
  document has no origin URL, and every reader now renders that absence as nothing rather than as
  `Title ()` or a bare `Source:` line.

  One fix rode along, found by the cross-runtime assertion for the new origin rather than by
  reasoning: `urlMatchCandidates` used to hand back `['', '/']` for an empty needle, so `getByUrl`
  would match every row whose stored `url` is empty. Nothing produced such a row before uploads, and
  no caller passes an empty URL today, but "a lookup for nothing resolves to an arbitrary uploaded
  document, which the caller then hands an agent as the page a description pointed at" is not a trap
  to leave armed. It now returns null, and the four repositories that call it answer "no match".

  A document is now attached to at most ONE block, enforced where the link is written rather than at
  the new endpoint. `linkedBlockId` is a single column, so attaching a document another task already
  holds MOVED the link instead of copying it: the earlier task silently lost a document it was created
  with, and nothing in its next run reported the absence. That was reachable from the app's own
  picker too, which offers already-attached documents for re-use. `linkToBlock` now refuses with
  `document_already_linked` and the holder's id, the same rule and shape as one-task-per-ticket, with
  translated SPA copy. Two things keep it from wedging anything: a link naming a DELETED block is not
  a holder (so the guard heals rows left by past deletes), and `removeBlock` now detaches a doomed
  block's documents through the removal cascade, so new ones are not made. Only the link goes; the
  document survives its task.

  Attaching a list is one unit of work rather than a loop: `linkManyToBlock` asserts the block once,
  resolves the whole list through a new batched `DocumentRepository.listByRefs` and writes the links
  through a new `linkBlockMany` (both mirrored D1 ⇄ Drizzle, with cross-runtime assertions, plus
  `detachBlocks` for the cascade). The point method in a loop was three round-trips per document, ten
  of which re-read the same block.

  Worth watching in review: the creation is all-or-nothing. Everything refusable (an unconfigured
  source, an unparseable ref, a page the provider will not serve, an upload that renders to no
  readable text, a document another task holds) is refused before the board changes, and an
  attachment that fails after the task exists takes the task back off the board, because a task
  silently missing part of its spec is the failure this whole surface exists to prevent. Two ordering
  details carry that: uploads are written only after the whole list resolves (an import is idempotent
  on its ref, but every upload mints an id, so an eager write would leave one orphan per retry), and
  the rollback detaches by BLOCK rather than by the refs it resolved (a rollback can be running
  because one of those refs belongs to another task, and clearing it by ref would commit the very
  loss the guard just refused). The attach runs before the ticket claim so that rollback can never
  orphan a claimed ticket. Naming `documents` does not work in mothership mode yet, for the same
  reason `ticket` does not: the document write surface is still `pending` on the persistence
  allow-list, which the new `linkBlockMany`/`detachBlocks` join rather than widen.

## 0.7.0

### Minor Changes

- 8cbf1a7: Manage the outbound notification webhook over `/api/v1`, so the whole integration surface is
  headless.

  `GET|PUT|DELETE /api/v1/notification-webhook` (`admin` scope) register, read and remove the one
  HTTPS endpoint a workspace pushes its notifications, run-lifecycle events and platform-health
  alerts to. Until now that endpoint could only be registered over the session-authed
  `/workspaces/:ws/notification-webhook`, so a deployment driven entirely by API keys had to put a
  human in a browser to switch on the very channel that exists because there is no browser: the
  delivery contract was headless and its enrolment was not.

  The routes delegate to the same `NotificationWebhookService` the session controller calls, so the
  SSRF guard on the endpoint, the keep-on-omit rule for every field and the one-row-per-workspace
  invariant are identical whichever surface writes. The signing secret stays write-only: `PUT`
  accepts one and the read reports only `hasSecret`, so an `admin` key can rotate it and can never
  learn the stored one.

  `PUT`'s `url` becomes optional, on both surfaces, so keep-on-omit is uniform across every field
  rather than every field but one. A mandatory re-send made the routine edit (subscribe to a family)
  carry a value the caller never meant to change, and a client re-sending a URL it cached before
  someone else rotated the receiver would silently redirect the workspace's deliveries back to the
  old endpoint while appearing to add a subscription. `url` is still required on the first `PUT`
  against a workspace with nothing registered, refused with `details.reason: "webhook_url_required"`.
  Relaxing a required field is additive, so no live caller changes.

  Additive on `/api/v1` (OpenAPI `info.version` 1.5.0; main took 1.4.0 for its own additive change
  while this branch was open). The four SDK clients gain a `webhook` resource
  (`get` / `set` / `delete`) and the MCP facade the matching `webhook_*` tools.

## 0.6.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.

## 0.6.0

### Minor Changes

- 10e0341: Answer the pre-dispatch input gate over the public API, and stop it judging blocks that carry no
  authored task input.

  The gate is the one park that turns on the shape of the TASK rather than the pipeline, so the
  public surface's park enumeration (which reads the step chain) could not see it: a `write`-scope
  key could start a title-only task on a pipeline that parks nowhere and get a run stopped before
  its first dispatch, with `GET /api/v1/runs/:runId/decisions` reporting `parked: true`, nothing to
  answer, and cancel as the only exit. The verdict is now a parked decision of its own, resolvable
  at `POST /api/v1/runs/:runId/decisions/input-gate/resolve` with the same `recheck` / `proceed`
  choices the app offers, and admission composes it in, so a key that cannot answer the park is
  refused up front with a message naming it. Additive on `/api/v1`: OpenAPI `info.version` 1.2.0,
  and the four SDK clients gain `decisions.resolveInputGate`.

  `not_applicable` now covers any block whose description is not authored task input, which is the
  block LEVEL plus the recurring task type rather than a task-type list alone. A run started against
  a frame, module, epic or initiative ANCHOR reads the entity it stands for, not the caption on the
  card, so judging that caption parked every initiative planning run on a field the flow never fills
  in. A task the platform merely CREATED with a real brief (an initiative-spawned item, a ticket
  import) is deliberately still judged.

  Advisory findings are also visible at last: they were recorded on the run and reported over the
  API while rendering nowhere, which left `advisory` mode with nothing to watch.

## 0.5.0

### Minor Changes

- cc17221: Price the three input token classes at their own rates and surface the resulting cost on the run
  and debug surfaces.

  `ModelPrice` gains `cacheReadPerMillion` / `cacheWritePerMillion`, derived from the base input
  rate where an entry names neither. This fixes a spend-gate defect as well as adding a display:
  the ledger previously metered every input token at the fresh rate, so a cache-read-dominated run
  was priced at roughly ten times its real cost and could exhaust a budget it had barely touched.

  The telemetry stores now aggregate one grain finer (`agentKind, phase, provider, model`) so a
  run's rollup can be priced while the model is still attached, and `priceRollupCells` folds the
  model away again, returning the `(agentKind, phase)` cells every consumer already read, now
  carrying `costEstimate`. That collapsed cell is its own type (`LlmRollupCell`), so a reader
  cannot ask it which model it was: after the fold there is no single answer. An unpriceable slice
  reports `null` rather than `0`, and a total containing one propagates that null instead of
  reporting a partial sum as complete.

  Public API (`/api/v1`), additive, `info.version` 1.1.0 → 1.2.0: the debug run overview's LLM
  rollups carry `costEstimate` and the block carries `costCurrency`. The four SDK clients are
  regenerated; the Python and Java manifests are bumped so the new models publish.

  The run's LLM-metrics export now states whether it is `truncated`. It is capped at the newest
  1000 calls, and a cost folded from that slice would be a smaller number that still reads as the
  run's total, so a truncated bundle reports null costs rather than pricing the part it holds.

## 0.4.0

### Minor Changes

- 36b1853: Ticket context is a first-class input to public task creation, and Jira ADF replies are read.

  `POST /api/v1/services/:serviceId/tasks` takes an optional `ticket` (`{ source, ref }`, where
  `ref` is a canonical issue key or a full issue URL). The platform imports that issue and ATTACHES
  it to the new task, the same linkage the app's own create-from-issue produces: each agent step
  re-reads the live issue as context, the writeback path posts a run's clarification questions onto
  it, a reply typed on the ticket resolves against the parked run, and the intake sweep treats the
  issue as taken. Before this a headless intake could only paste the issue into `description`, which
  kept the words and lost all of that.

  Additive on the wire (OpenAPI surface `1.0.0` → `1.1.0`; regenerated in all four SDKs). Two
  refusals are worth knowing about: the ticket is resolved BEFORE the task is created, so an unknown
  source or an issue the tracker will not serve leaves the board untouched rather than producing an
  unlinked task; and a ticket already linked to another task is a `409` carrying
  `details.reason: 'ticket_already_linked'` plus `details.taskId`, which is what lets a redelivering
  integration follow the existing task instead of filing a duplicate. That reason is now also
  emitted by the app's create-from-issue, which previously refused the same condition in prose only.

  One task per ticket now holds under CONCURRENCY, which is what redelivery actually produces. The
  read that refuses has already returned by the time a task is created, so `TaskRepository` gains
  `claimBlockLink` (a conditional write on `linked_block_id`, mirrored D1 and Drizzle with a
  concurrent conformance assertion) and both filing paths go through it. Previously two simultaneous
  filings of one issue both succeeded, and the second silently re-pointed the link, stripping the
  first task of the context it was created with. The headless filing additionally rolls its task
  back off the board when it loses, so retrying on the `409` cannot accumulate duplicates.

  Jira's ADF renderer is also bounded now. A comment body is external structure rather than something
  the vendor's editor produced, and a recursive walk over it was an unbounded stack and, on the
  Worker, an unbounded request budget. It renders under a node and depth budget far above any real
  document and states it when either is hit, rather than stopping where a reader would read the cut
  as the end of the text.

  Separately, Jira Cloud comment webhooks are read as Atlassian Document Format. Jira v3 sends
  comment bodies as an ADF document rather than a string, so every rich-text reply was dropped
  before it reached the review-reply grammar, and silently: an unparsed delivery is acked, so a
  reporter who answered a clarification question in Jira's own editor got nothing recorded and no
  acknowledgement saying so. The bodies now go through the import path's own `adfToMarkdown`, which
  gained the leaf nodes that carry their text in `attrs` (mention, emoji, status, smart link) so a
  name, a state or a link no longer vanishes out of the middle of a sentence.

## 0.3.0

### Minor Changes

- 1106c93: BREAKING (public API, the last permitted break): the final pre-stability polish of `/api/v1`,
  adopted together with the stability commitment (ADR 0032). From this release the public API does
  not change without an incremental migration path and a version change.

  - `POST /api/v1/initiatives` moved to `POST /api/v1/jobs`, unifying the headless job lifecycle
    under one resource root. The SDK group `initiatives` is now `jobs`; the wire schemas renamed to
    `CreatePublicJob` / `PublicJobAccepted`.
  - `publicTask.executionId` renamed to `publicTask.runId`, matching `publicRun.runId` and
    `/api/v1/runs/:runId/...`.
  - `POST /api/v1/tasks/:taskId/start` now requires a `decide`-scope key when the resolved pipeline
    can park on a human decision, the same rule `POST /api/v1/jobs` applies. Existing `write` keys
    that started such pipelines get `403 pipeline_requires_decide_scope`.

  **Check your integrations against this last one before upgrading.** A pipeline parks in three ways,
  and the third is easy to miss: an approval gate on an enabled step, an inline review/brainstorm
  kind, or an unbounded human-wait gate (`human-review`). That third case means the shipped
  **Adaptive build** preset (`pl_full`) now needs a `decide` key, because it carries a risk-gated
  `human-review` step. The unconditional presets (`Standard build`, `Simple build`) never park and
  remain startable with a plain `write` key, as do the pipelines a workspace authored without gates
  or review kinds.

  Mint a `decide`-scope key for any integration that starts parking pipelines. The scope only widens
  what a key may set in motion; it grants no destructive capability (that is `admin`).

## 0.2.0

### Minor Changes

- 8b31fe0: Add official public-API SDK clients for TypeScript, Python, Go and Java (the Java artifact also
  serving Kotlin), plus a cross-SDK smoketest and release gating.

  Models and operation methods are **generated** from `docs/openapi.json` — itself generated from
  the Valibot route contracts — so a client cannot drift from the deployment it talks to. Each SDK's
  transport, error hierarchy, retry policy, pagination helper and SSE reader are hand-written, so a
  contract change never rewrites behaviour and a behaviour fix is never re-applied 38 times in four
  languages. `pnpm gen:sdk` regenerates; `pnpm check:sdk` guards drift and version skew in CI.

  `backend/internal/sdk-smoketest` boots a real Node backend and drives the same scenario through
  all four clients, comparing their observation reports — the only check that can see the four
  disagree.

  **No separate Kotlin SDK, deliberately.** Kotlin's own `@Metadata` cannot be synthesised onto a
  Java jar, but the metadata Kotlin _reads_ can be: the model and resource packages are JSpecify
  `@NullMarked`, Kotlin hard keywords are escaped (`PublicPipeline.public` → `isPublic()`, wire name
  preserved), the error hierarchy is sealed, builders replace absent default arguments, and enums
  tolerate unknown values. A Kotlin caller gets real nullability instead of platform types; what it
  does not get is `copy()`/destructuring on the records.

  Also fills a documentation gap in the published OpenAPI spec: 11 operations (the whole
  `/api/v1/debug/*` surface plus `deletePublicTask`, `listPublicJobs` and `resolvePublicRunJudge`)
  carried no summary or description and were tagged with a catch-all `Public API` tag. They are now
  documented and tagged `Debug` / `Tasks` / `Initiatives` / `Decisions`, so the four generated
  clients inherit real docs.

### Patch Changes

- 8b31fe0: Keep the SDK `User-Agent` version constants in step with their manifests on release.

  `@cat-factory/sdk` is an ordinary workspace package, so changesets bumps
  `sdk/typescript/package.json` when it builds the release PR — but nothing updated the two constants
  derived from that number (the TypeScript transport's `SDK_VERSION`, and Go's `Version`, which
  tracks the TypeScript manifest because a Go module carries no version of its own). Every release PR
  would have been born red on the version-skew half of `check:sdk`.

  `scripts/sync-sdk-versions.mjs` now runs from the root `version` script, the twin of
  `sync-runner-image-tags.mjs`, with the manifest/constant table shared with the guard so the writer
  and the checker cannot drift.

- 8b31fe0: Fix what the SDK clients' request deadline bounds, and how live stream frames reach a caller.

  The four clients disagreed about a stream's lifetime, and two of them were wrong. Go's per-attempt
  `context.WithTimeout` kept running over the response body, so every `Stream` died at `Timeout`
  (30s by default) with `context deadline exceeded` on a run that was healthy. Python's reader called
  `read(1024)` on urllib's `HTTPResponse`, which blocks until it has 1024 bytes — so no frame reached
  the caller until the stream ENDED and they all arrived at once. Both present as the same thing in
  production: a run that silently appears to stall.

  The deadline now bounds the RESPONSE and never a stream, in all four. That is the correct semantic
  for this API rather than a convenience: the deployment writes an SSE frame only when a run's
  projection changes, sends no heartbeat, and a parked run waits for a human indefinitely by design,
  so a quiet stream is the normal state of a healthy one.

  Also in the hand-written halves: a TypeScript caller abort carrying a non-`AbortError` reason is no
  longer retried and reported as a connection failure; `close()` on a stream that was never iterated
  now actually releases the socket; Java stops emitting duplicate `authorization` headers when a
  caller supplies their own, and an unmapped 4xx (402, 413, a status this surface gains later) stays
  the base exception instead of being reported as a deployment fault; Go gains the `TimeoutError` the
  other three already had; every SDK reads both `Retry-After` wire forms; and an auto-pager that is
  handed back the cursor it just sent raises instead of looping forever.

  Generated Go parameter names lose a leading-initialism bug that spelled ten published signatures
  `Cancel(ctx, iD string)`.

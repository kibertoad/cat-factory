# @cat-factory/gatekeeper-bindings

## 0.12.0

### Minor Changes

- 83764b5: Put a run's live environments on the outcome summary (spec 1.38.0, outcome `version` 3). Additive.

  The outcome summary gains an `environments` section: one row per throwaway environment the run
  stood up, carrying its URL, its state, the TTL instant when the platform recorded one, the service
  frame it belongs to, the environment id an operator greps for, the producer's verbatim cause, and
  whether the run's deployer declared that the environment outlives the run. The app's outcome card
  renders it beside the captured views, and `GET /api/v1/runs/:runId/outcome` serves the same
  reduction, so "click and look" no longer means opening the step that provisioned it.

  `state` is the field that matters and `live` is the only one that offers a link. Every other row
  (`provisioning`, `failed`, `reclaiming`, `reclaimed`, `expired`) still carries whatever URL it had,
  because that is what names the environment, so a consumer rendering the URL without the state
  beside it hands someone a link to something that is no longer there. A client with a clock owes the
  other half of that: `expiresAt` is served as an instant rather than folded into `state` (the
  reduction is clock-free so the app and the endpoint cannot disagree about one run), so a `live` row
  whose TTL has passed is not a URL to hand anyone.

  Several producers know something about the same environment, and they are reconciled BY IDENTITY
  before they are ranked: the run's step projections and the `human-test` gate's own record fold into
  one observation per environment id, above which the disposer's terminal record wins and below which
  the deployer's provision-time row is the floor. An environment a LATER deploy of the same frame
  replaced is reported as gone, derived rather than observed, since nothing refreshes its projection
  again. A reclaim that FAILED leaves the row `live` with the provider's cause beside it: the
  environment is still standing and its URL still works, and that it should not be is the verification
  report's teardown proof rather than this section's question.

  Absences stay three distinct facts: `no_environment_step` (the pipeline provisions nothing),
  `not_provisioned` (something was meant to and nothing is recorded yet) and `infraless` (every frame
  declares no environment of its own). `hasOutcomeToShow` counts a reported environment, so the "read
  the result" affordance now appears on a run whose only product so far is something to look at.

  The rules this shares with the PR verification report moved into contracts' `run-evidence.ts`
  beside the tester rules: which frames the run's deploys settled, what it observed of each
  environment, which recorded lifecycle states mean one is gone, and whether the deployer declared
  retention. The disposer reclaims by the same fold, so the set of environments a run stood up has one
  statement rather than three. `DEPLOYER_AGENT_KIND` / `DISPOSER_AGENT_KIND` are defined there now and
  re-exported from `pipeline-environment-lifecycle.ts` under the same names, so no importer moves.

  A `deployer` step now also records the environment id on a frame whose provision FAILED, where the
  provision got far enough to have a record to fail against. Internal step state, so stale rows simply
  lack it; what it buys is that the failed environment the run projected is nameable as the one that
  frame broke on rather than surfacing as a second environment nothing accounts for.

  The spec generator's per-version changelog moved to `backend/docs/public-api-versions.md`, a
  document rather than a 250-line comment block in a script: it grows with every release and never
  shrinks, and the file-size ratchet said so first. Nothing about how the number is set changed, and
  the note that makes the next silent version collision arrive as a merge conflict travels with it.

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/sdk@0.30.0

## 0.11.0

### Minor Changes

- bf473bd: `/api/v1` gains `GET /api/v1/runs/{runId}/spec` at `read` scope: the in-repo specification a run was
  judged against, read at the branch that run pushed its work to. Additive, so the OpenAPI surface
  version moves to 1.36.0 and nothing existing changes shape, scope or error vocabulary.

  It is the sibling `GET /api/v1/services/{serviceId}/spec` could not stand in for. That one answers
  the repository's default branch, and a task's spec increment does not merge while its pull request
  is open, so a caller joining `requirements` rows from `…/report` or `…/outcome` back to the criteria
  they were scored against found no criterion for exactly the rows the run had added. The pair mirrors
  the internal split the SPA's outcome card already needed for the same reason.

  Both public reads and both internal ones now go through one reader, and the run read goes through
  the engine's own evidence loader, so the tree a caller joins against is the tree the platform joined
  against: the same branch rule, the same tester gate and the same per-run memo the verification
  report and the outcome summary use.

  The loader change worth knowing about is that it now reports WHERE a spec read stopped instead of
  folding every outcome onto an empty view. The two reductions still fold (a coverage section states
  its own absence), but the endpoint does not: an unwired integration and an unreadable repository are
  `503`s carrying their own `details.reason`, and a fourth `anchor` value, `not_read`, says the
  platform has consulted no tree for this run yet. Folded, an outage would have told an integrator
  that a run was judged against a service declaring no requirements.

  The read also resolves the branch head before walking, which adds one repository call per run
  (memoised with the tree, so a later reader gets the commit the tester ruled at rather than one
  resolved afterwards). That resolution now carries a second job: a run keeps naming its pull
  request's head branch after the branch is deleted, which is the ordinary sequel to a merge, so a
  read that finds neither a head nor an anchor there falls back to the repository default and names it
  in `provenance.ref`. Without it the post-hoc audit this endpoint exists for was the one case that
  answered a permanent `503`. Only a confirmed missing branch moves the read; a host that will not
  answer for the ref leaves it alone, so an incident cannot swap the tree.

  Between the two wiring refusals and the `not_read` gate, the gate now goes first: before a tester
  reports, a run answers `not_read` whatever the deployment wired. Ranked by what was cheap to check,
  an unwired deployment and an unconnected workspace behaved differently for the same run, one
  answering `503` throughout and the other flipping from `200` to `503` partway through.

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/sdk@0.29.0

## 0.10.0

### Minor Changes

- 875daf7: Serve the Cloudflare OS object model, with the workspace's approval queue in front of every call.

  `@cat-factory/gatekeeper-worker` gains four factories a deployment exports under the names the
  workspace resolves: `GatekeeperVendor` (the entrypoint a `GATEKEEPER_*` service binding targets),
  `CatFactoryAccount`, `CatFactoryResource` and `CatFactoryVerifier`. A resource is the paired
  cat-factory workspace, named by a URLPattern over the deployment origin, because the provisioning
  key this Worker holds is scoped to one. On that path each read is authorized before it is MADE (a
  refused observation means the upstream call never happened, which matters most for the reads that
  serve captured agent text) and each write is submitted and performed only when the workspace
  applies it; the tier policy stays the floor underneath. A session owns the queue it was opened
  with: disposing it releases the queue and refuses every action it left undecided, so a resource
  object holds pending work for live sessions only. `/rpc` and the admin routes are unchanged and
  still bearer-gated.

  `GET /health` gains an `os` section reporting whether a Cloudflare OS deployment could discover and
  install this Worker: `{ ok: true, os: { discoverable, blockers } }`, where a blocker is a missing
  object-model export or a policy naming no `autoProvisionedTier`. It is reported rather than folded
  into the status, because a Gatekeeper serving `/rpc` and nothing else is a supported deployment and
  its monitors must not go red on a version bump.

  `@cat-factory/gatekeeper-bindings` gains `SESSION_METHOD_SIGNATURES` (generated, one TypeScript
  method signature per operation) and `renderSessionTypes`, which composes the `.d.ts` a granted
  session serves.

  Policy files gain `autoProvisionedTier`, and a deployment that wants Cloudflare OS discovery must
  set it. It does not inherit from `defaultTier`: a workspace mints accounts with no identity, so no
  account can match a `grants` entry, and sharing one knob would mean turning discovery on also
  widened the `/rpc` door. Existing policies are unaffected and keep working with discovery off.

## 0.9.1

### Patch Changes

- 3036af7: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
  (`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
  Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
  exactly one Vue.

- Updated dependencies [3036af7]
  - @cat-factory/sdk@0.28.1

## 0.9.0

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

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/sdk@0.28.0

## 0.8.0

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

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/sdk@0.27.0

## 0.7.0

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

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/sdk@0.26.0

## 0.6.0

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

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/sdk@0.25.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/sdk@0.24.0

## 0.4.0

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

### Patch Changes

- Updated dependencies [01bb6d2]
  - @cat-factory/sdk@0.23.0

## 0.3.0

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

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/sdk@0.22.0

## 0.2.1

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/sdk@0.21.0

## 0.2.0

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

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/sdk@0.20.0

## 0.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/sdk@0.19.0

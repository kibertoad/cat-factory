# @cat-factory/gatekeeper-bindings

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

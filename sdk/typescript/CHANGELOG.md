# @cat-factory/sdk

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

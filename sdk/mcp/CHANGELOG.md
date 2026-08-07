# @cat-factory/mcp-server

## 0.15.0

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

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/sdk@0.17.0

## 0.14.0

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

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/sdk@0.16.0

## 0.13.0

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

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/sdk@0.15.0

## 0.12.0

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

### Patch Changes

- Updated dependencies [7f5ed08]
  - @cat-factory/sdk@0.14.0

## 0.11.0

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

### Patch Changes

- Updated dependencies [bac6776]
  - @cat-factory/sdk@0.13.0

## 0.10.0

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

### Patch Changes

- Updated dependencies [e7867db]
  - @cat-factory/sdk@0.12.0

## 0.9.0

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

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/sdk@0.11.0

## 0.8.0

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

### Patch Changes

- Updated dependencies [289b3de]
  - @cat-factory/sdk@0.10.0

## 0.7.0

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

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/sdk@0.9.0

## 0.6.0

### Minor Changes

- 8511a90: MCP maturation slice 3: the public API is now served over MCP from the deployment itself.

  `POST /api/v1/mcp` speaks Model Context Protocol behind the same public-API key auth as every other
  `/api/v1` route, so an MCP host reaches a deployment with a URL and a key and nothing installed. That
  is the point of the slice: until now "drive cat-factory from a model" meant an npm dependency, a local
  process per host and a long-lived key in the host's plaintext config, which rules out claude.ai, hosted
  agents and anything that cannot spawn a subprocess. The stdio binary stays, for hosts with no HTTP MCP
  support and for use against a deployment you do not run.

  It is the SAME server behind both paths: the endpoint mounts `@cat-factory/mcp-server`'s
  `handleMcpHttpRequest`, so the generated tool table, the instructions and the result rendering are the
  same bytes, and every tool call is one `/api/v1` request under the CALLER's own forwarded key. Nothing
  is reachable over MCP that the same key could not reach with `curl`. Behaviour worth knowing about:
  the key's SCOPE decides the tool list (a `read`-scoped key is served only the tools that change
  nothing, and the instructions say a wider key would expose the rest, so a model asks for one instead of
  reporting the platform as unable to write); above `read` the whole table is listed and each tool's own
  rung is enforced by the endpoint it calls, arriving as tool content the model can act on; and the
  endpoint is stateless with JSON responses, so `GET` and `DELETE` are answered `405`.

  Two things a caller and an operator each notice. A tool's `/api/v1` call INHERITS the MCP request's
  `X-Request-Id`, so the tool call and the API call it caused share one correlation id and a log holding
  both lines can be joined on it (supply your own on the MCP request and both halves land under it).
  And `Mcp-Protocol-Version` joins the shared CORS allow-list both facades serve, without which a
  cross-origin BROWSER host would negotiate successfully and then have every later call dropped by the
  browser, since a Streamable HTTP client sends that header on every request after `initialize` and on
  none before it.

  The endpoint joins the PUBLIC surface under the stability contract from this release. It is
  deliberately absent from `docs/openapi.json`: a JSON-RPC endpoint has no operation shape to describe,
  and describing it would mint an SDK method in four languages for a protocol none of those clients
  speaks. `backend/docs/public-api.md` carries the obligation instead, which also means the endpoint's
  arrival does not move the spec's `info.version`: that version tracks the described surface.

  `@cat-factory/mcp-server` gains `handleMcpHttpRequest` / `refuseMcpMethod`, so any deployment of this
  API can mount the endpoint, plus a `readOnlyReason` option that lets the instructions name the right
  fix for a narrowed tool list.

  INTERNAL BREAK in `@cat-factory/mcp-server`: `optionsFromEnv(env, deps)` now REQUIRES
  `deps.readSecretFile` rather than defaulting to `readFileSync`, and `ToolSelection.writeToolsHidden` is
  a `ReadOnlyReason | null` rather than a boolean. The first is what keeps every module the hosted
  endpoint reaches free of Node built-ins: those modules are bundled into deployments' Workers, where
  `node:fs` does not resolve at build time, so the default was a Worker that fails to BUILD for the sake
  of a code path it can never take. `bin.ts` supplies the reader.

### Patch Changes

- @cat-factory/sdk@0.8.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/sdk@0.8.0

## 0.4.0

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

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/sdk@0.7.0

## 0.3.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- Updated dependencies [1f14793]
  - @cat-factory/sdk@0.6.1

## 0.3.0

### Minor Changes

- a8acd48: Bring the published MCP server under the repo's publish guards and give it the protocol depth the
  generator already had the data for.

  The tool table now declares an `outputSchema` for every operation that answers with a JSON object and
  returns `structuredContent` beside the text, so a host or agent framework can consume a result without
  re-parsing prose. Those schemas are rendered deliberately loosely (no `required`, no `enum`, no closed
  `anyOf`, no bounds, and for a union not even `type`): a caller's MCP client validates against them and
  `/api/v1` is additive forever, so anything stricter would let an older copy of this package reject a
  newer deployment's honest answer. `destructiveHint` / `idempotentHint` are now set on the operations whose consequence is real
  money or a merged pull request, and left unset elsewhere so the protocol's cautious defaults stand.

  Two behaviour changes to know about:

  - **A result over `CAT_FACTORY_MCP_MAX_RESULT_CHARS` is now refused rather than truncated**, with a
    message naming the size, the limit and the way out (`limit` / `cursor` / `offset`, or a bigger cap).
    Half an object cannot satisfy the output schema it was cut out of, and the old `[TRUNCATED]` prefix
    spent the whole cap delivering the instruction to narrow instead of reading on.
  - **Results are compact JSON**, not two-space indented.

  New configuration: `CAT_FACTORY_API_KEY_FILE` reads the key from a file instead of the host's
  plaintext config (setting both is refused, not resolved by precedence), and
  `CAT_FACTORY_MCP_TOOLS` / `CAT_FACTORY_MCP_EXCLUDE_TOOLS` filter per tool beside the existing group
  filter, so withholding the PR-merging `notifications_act` no longer costs the whole inbox group. Every
  filter is stated in the server's instructions, and a combination that would expose no tools at all
  fails at startup.

## 0.2.1

### Patch Changes

- Updated dependencies [10e0341]
  - @cat-factory/sdk@0.6.0

## 0.2.0

### Minor Changes

- 43fd5c0: Add `@cat-factory/mcp-server`: a Model Context Protocol facade over the public API, so an MCP host
  can drive a workspace directly (plan work on the board, start and watch runs, answer parked
  decisions, read a run's telemetry).

  It is a facade rather than a fifth client. The tool table is rendered by `pnpm gen:sdk` from the
  same `docs/openapi.json` the four SDKs are generated from, and every tool is one call on
  `@cat-factory/sdk` — so it cannot drift from the surface it exposes, and it re-implements none of
  the SDK's auth, retry, error, pagination or encoding behaviour. `pnpm check:sdk` covers it.

  Every operation is a tool except the two SSE endpoints: a tool call returns one result over no
  streaming channel, and a bounded "wait for the run" tool would be a timeout dressed up as an
  answer, since a parked run waits for a human indefinitely by design. The server names both
  omissions, and their alternatives, in its instructions; generation fails on a new streaming
  operation nobody has classified.

### Patch Changes

- @cat-factory/sdk@0.5.0

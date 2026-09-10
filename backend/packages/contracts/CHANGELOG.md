# @cat-factory/contracts

## 0.353.0

### Minor Changes

- 5dc7506: Drive the whole PR deep review through `/api/v1`
  
  Triggering a review of an existing GitHub or GitLab pull request, reading back its prioritized
  findings and posting the ones a person kept as inline comments was already reachable over the
  public API, one call at a time. Driving it end to end was not, for three reasons that only show up
  once something goes wrong.
  
  **A `post` that failed reported nothing.** A partial or total failure re-parks the review at
  `awaiting_selection` with its resolution cleared, which is byte-for-byte a review nobody has
  curated yet: a caller that posted seven comments and landed none read back the state it held a
  moment before, and either looped or reported success. The `pr-review` decision now carries
  `postReport` (what was attempted, what posted, what was folded into the summary comment because its
  line falls outside the diff or the branch moved, and the provider's own error per finding) and
  `postedFindingIds` (what a retry skips, so re-posting the same selection never double-comments).
  The report names the PASS it describes (`attempt`, against the decision's `postAttempts`), because
  a retry that fails identically leaves an otherwise byte-identical report and the defect would
  reappear one level in; `postedBody` states whether the summary comment has landed, so
  `bodyPosted: null` is readable as "suppressed, it already went" rather than "there was none". A
  finding dismissed after a failed pass loses its `failures[]` row with it, so no id on this surface
  names a finding the caller can no longer see.
  
  **A wedged review had no exit but throwing the work away.** The reviewer fans its slices out across
  parallel subagents and emits findings only in a final aggregation turn, which can hang with every
  slice finished; the watchdogs cannot see it and the 60-minute kill discards the lot. The app could
  already re-dispatch only the slices that never reported, and now so can a key:
  `POST /api/v1/runs/{runId}/decisions/pr-review/resume`. BOUNDED, unlike the app's own resume, and
  projecting the evidence a bound needs (`resumeAttempts` / `maxResumeAttempts`, `reportedSlices`,
  `lastActivityAt`): each call stops the running reviewer and starts a fresh container, so a poller
  resuming on a timer shorter than the review takes would otherwise kill it forever, each time it
  was about to finish. A person clicking Resume in the window is watching what they nudged, which is
  the judgement a headless caller cannot supply.
  
  **A `write` key could start a review it could not finish.** Both `pl_review` and `pl_bug_fishing`
  are single-step pipelines whose step parks the run for a person to curate what it found, and public
  admission could not see that park: the two kinds park through machinery of their own rather than
  through anything a registry declared, so a `write` key was admitted and then held a run whose every
  verb needs `decide`. Both kinds now carry a `curation-gate` trait, which is the sixth park mechanism
  admission enumerates and the fourth it derives from a registration, so a deployment's own curating
  kind is seen with no edit there. **Starting either preset now needs a `decide` key**
  (`403 pipeline_requires_decide_scope`), and so does RETRYING a run whose stored steps carry one: a
  start path is not the only way to set a park in motion. The refusal names `pr-review` as answerable
  through the decision surface and `bug-fisher` as not, and it names the DECISION KINDS rather than
  the park surfaces, three of which are spelled differently in the two places (a `pr-reviewer` step
  is answered by a `pr-review` decision, both brainstorm kinds by one `brainstorm`), so an
  integration mapping the refusal onto `decisions[]` no longer hunts for an entry that is never
  there. A run parked on the curation this API cannot answer now NAMES that wait
  (`unanswerable[].reason = "curation_gate"`), which is what makes "honestly reported as parked with
  nothing to answer" true rather than an empty list plus an approval that would end the run.
  
  OpenAPI `info.version` 1.71.0 → 1.72.0. The Python and Java clients (Kotlin with them) carry the
  new operation and models too, so their manifests move 0.6.0 → 0.7.0: for those two the version
  change IS the release, so regenerating without it would have shipped the loop in two clients of
  four.

## 0.352.0

### Minor Changes

- b75fa3c: Let a service say, in its own words, how it should be tested
  
  A Tester was handed two things about a service it did not stand up: where to reach it, and which
  credentials its shell carries. Neither says which flows matter, which of the seeded accounts is the
  one to sign in as, what the demo data means, or which flow charges a real card. That knowledge
  exists, it is short, and until now there was nowhere to put it, so every Tester run rediscovered it
  from the repository or guessed.
  
  **Testing context** is a freeform text box on the service frame's inspector, directly beneath the
  sealed test credentials (advanced interface tier, and shown at either tier once a service records
  one, so nobody is left unable to read or clear what their testers are being told). It is stored on
  the service and injected verbatim into every tester prompt for it. The environment self-test's agent dry run is handed the same text through the same renderer:
  a dry run's whole claim is that it predicts what a real Tester will be able to do here, and it cannot
  predict that from a different briefing.
  
  Three decisions worth knowing:
  
  - **It is non-sensitive by contract**, because it is rendered INTO the prompt. Secrets stay in the
    sealed panel above, which never renders a value into a prompt or into telemetry, and this prose
    refers to them by variable name. The panel says so.
  - **The empty case is stated to the agent, never omitted.** A Tester told nothing cannot tell "this
    platform has nowhere to write that down" from "the place exists and nobody filled it in", so it
    either reports no gap at all or reports one against the service. Told, it reports what it had to
    guess at, which is what tells an operator what to type. A tester running on work that sits under
    no service frame is told THAT instead, so an empty field and an absent owner cannot be reported
    as the same neglect.
  - **It is a `blocks` column, not a table**, for the reason `provisioning` and `service_connections`
    are columns: one service-frame-owned value the engine reads off the frame it has already walked
    to. Both runtimes gain the column and a conformance assertion drives the frame-chain walk on both
    stores; the write boundary drops the field on any non-frame block rather than persisting dead data.
  
  Only the two tester kinds are handed it, so every other agent's prompt is byte-for-byte unchanged,
  and a service that records nothing keeps the prompts it had.

## 0.351.1

### Patch Changes

- afd09af: Say what the assistant can do here, instead of offering a box that cannot submit
  
  The assistant opened with a narrow three-row box, no examples, and a Run button that stayed disabled
  no matter what was typed. The cause is a trap for every lazily mounted panel in this SPA: the page
  mounts a modal only while its open flag is set, so the component's `open` is already true at setup,
  and the change-only watcher that read `GET /assistant` never fired. Nothing ever read the
  capability, so the store held no actions and `available` stayed false, which the modal rendered as a
  prompt box with a dead button and nothing said about why.
  
  That trap is now closed for the whole SPA rather than at the one site that got reported.
  `onModalOpen(open, fn)` is the shared seam, and every panel that seeds state or issues a read on the
  way in goes through it: `BugHuntModal` and `TaskImportModal` were carrying the same live bug (both
  opened with an unselected picker and never loaded their sources), and four more were one edit away
  from it. The rule is written up where a modal author reads it, in the frontend README.
  
  The reason the failure was invisible is the part worth reviewing. A null capability was carrying
  three different facts (nobody asked, the read is in flight, the read failed), and a fourth answer,
  "read, and this deployment wired no model", was the only one the modal could describe. The modal now
  derives its surface from the ANSWER: an unwired deployment, an empty action catalog and a failed
  read are three panels with three different remedies, and the empty catalog is not folded into the
  unwired case because every submit against it is refused with `assistant_no_actions`.
  
  A read still in flight is deliberately not one of those panels. It shows the box with Run disabled
  and the wait stated beside it, because withholding the box until the read lands drops the characters
  typed in the gap: the assistant is opened from the sidebar and the command palette, where the hands
  are already on the keyboard. A re-open keeps the answer it already holds while the re-read runs, so
  the box does not flash back to a spinner for a fact the store can state.
  
  A disabled Run owes a reason, and it owes it to a reader who cannot see the sentence too: the reason
  line is a live region named by the button. The prompt cap is exported from the contracts package
  (`ASSISTANT_PROMPT_MAX`) rather than retyped in the SPA, and the per-argument cap is now its own
  constant, since pointing both at one number made either unmovable.
  
  The assistant's agent kind now appears in the Model Defaults panel, beside Kaizen and the fixers.
  It already resolved the workspace preset's base model like every other kind (that is now pinned by
  tests rather than assumed); what it lacked was the row an operator pins a different model on, and a
  label anywhere a spend rollup names the kind that spent it.
  
  Worth watching: the capability read carries its own deadline and aborts what it gives up on, because
  the shared client sets no timeout and a stalled read would otherwise leave the modal with no answer,
  no failure, and so no retry either. Its failure is reported by the panel rather than the toast
  funnel, which is a deliberate exception to the funnel rule: the panel is where the retry is, and a
  toast would stack a second non-dismissing copy of the same sentence on every attempt.

## 0.351.0

### Minor Changes

- 2ae7e2b: Add a bugfix preset that proves the fix from the repository and spends the environment on one question
  
  Every way the platform had of establishing that a change works needs a running system: the API and
  UI testers read a provisioned ephemeral environment, and the acceptance author writes tests that
  target one. On a deployment whose preview environments are slow, costly or not representative, that
  makes a bugfix wait on infrastructure to answer a question a committed test answers better, and it
  leaves nothing behind: the environment goes away and the next regression is found the same way.
  
  `pl_bugfix_tested` ("Fix bug, verified by tests") is `pl_bugfix`'s investigate, triage, reproduce,
  fix, review spine with the verification moved into the checkout:
  
  - **`mocker` then `integration-test`**, both after the fix and both before the `ci` gate. The mock
    step is the existing one (WireMock stubs the repo owns, wired into compose and CI); the
    integration step is a new registered kind that drives the fix through the seam a caller uses
    against those stubs, commits the tests, and reports what it could NOT cover. CI re-running them
    is the enforcement, which is why the step is a `container-coding` kind rather than a tester: only
    the tester family is handed environment coordinates, so tests written here cannot come to depend
    on a URL even by accident.
  - **`deployer` then `disposer`, with nothing between them**, as a LAUNCH CHECK. The deployer
    provisions the pull-request branch and settles on a reachability verdict, so a service that no
    longer starts fails the run; a service that stands nothing up records a clean no-op as always.
    That verdict is the only thing this preset asks an environment for, so the reclaim is adjacent
    rather than terminal: holding the environment through the merge tail would bill for a URL no step
    is going to open.
  
  Three things about the new step are deliberate and worth knowing before editing it. Committing no
  test never fails the run (the fix is already pushed by the time it runs, so a failure would throw
  the work away rather than name the gap): it reports `outcome: 'uncovered'` with the reason, and an
  unreadable reply degrades to the same value rather than to a claim it never made. The gaps it
  states are rendered even under a `covered` verdict, because the reported behaviour being covered
  says nothing about the neighbouring case that is not. And its verdict is a claim about FILES, which
  tolerating a no-op makes uncheckable by anything else, so the platform records on the step whether
  the run committed anything and withdraws a `covered` claim an empty push contradicts, naming the
  claim rather than quietly showing it.
  
  `mocker` gains the same no-op tolerance, which is a fix to every preset that carries it rather than
  a concession to this one. Its own prompt tells it to add stubs only for calls not yet mocked, so an
  empty diff is the ordinary outcome on a repository whose upstreams are already stubbed, and the
  harness cannot tell that apart from an agent that did nothing. Failing there was also late: every
  preset runs the mocker after the coder has opened the pull request. That prompt now sizes the work
  to the change in flight too, instead of treating the block's whole external surface as mandatory.
  
  **Behaviour change: a marked BUG-FISHING finding now spawns onto this preset by default** instead of
  `pl_bugfix`. A fished defect has no reporter to reproduce it with and no environment anybody is
  watching it in, so the regression test committed beside the fix is the whole deliverable. Selection
  is unchanged and was already there at two tiers: the board's `bugFishingFixPipelineId` overrides the
  platform default for every spawn, and a single marking overrides both through the request's
  `pipelineId`. A workspace that had set the board field is unaffected.
  
  Two costs come with that default, both the launch check's, and both are documented rather than
  worked around: every marked finding provisions and reclaims an environment (a recorded no-op on an
  `infraless` service), and a marking is refused outright when the service declares provisioning it
  has not finished wiring, because a pipeline carrying an enabled `deployer` meets
  `RunAdmission.assertDeployerConfigured` and the marking propagates that refusal rather than
  answering 200 over a fix task that will never appear. `pl_bugfix` reached neither. A board that
  wants neither pins something else in `bugFishingFixPipelineId`.
  
  Existing workspaces pick the preset up the way every catalog addition arrives: the new-pipeline
  advisory offers it, a reseed inserts it, and a run that pins it by id adopts it. The bug-fishing
  spawn resolves its fix pipeline through that same adoption seam rather than a point read at the
  workspace's rows, which is what lets a board older than a built-in mark a finding at all.
  
  The run outcome summary gains one additive `/api/v1` value for the same reason (surface version
  1.71.0): `tests.gap: 'verified_by_committed_tests'`, so a run that verified through committed tests
  stops being reported as one where "nothing was exercised" on the one surface a person reads, while
  its pull request says the opposite.

## 0.350.0

### Minor Changes

- 6ff632f: Add the in-app assistant: type what you want done, and the platform does it
  
  Everything on the board is reachable, and reaching it means knowing which panel holds it. Putting a
  repository on the board is a modal behind a sidebar entry; filing a task from a ticket is a second
  modal plus a source picker plus a container picker; declaring that one service depends on another is
  a field in a frame's inspector most people never open. Each is several clicks from someone who
  already knows the sentence they would say.
  
  The assistant takes the sentence. It ships with three actions, the ones a request most often is:
  declare that one service depends on another (so both are spun up when either is tested), add a
  service backed by a GitHub or GitLab repository named by its URL, and file a board task from an issue
  URL (GitHub, GitLab, Jira, Linear).
  
  The design decision worth reviewing is that the model does not act. It reads the request, names one
  action from a closed catalog and copies that action's arguments out of the words in front of it;
  everything after that is deterministic. The platform looks the id up in the catalog it rendered,
  validates the arguments through the shared descriptor validator, resolves every name against the
  board itself, and performs the action through the same service the equivalent button calls. So a
  hallucinated action id is a decline, an invented argument key is a dropped key, and a service name
  matching nothing (or matching two) is a question with the candidates attached. Nothing the model
  writes reaches a side effect, a stored row, or the screen.
  
  That last part is also why a turn answers with DATA rather than a chat message: the outcome variant
  carries the ids and titles of what was touched, or the machine-readable reason it could not act, and
  every sentence a person reads is rendered by the SPA from the i18n catalog. Putting the model's own
  explanation on the wire would have made the surface untranslatable and put unreviewed model text on
  screen.
  
  A QUESTION is answered as data too. A turn that could not resolve an argument carries the action it
  was heading for and the arguments it did resolve, so clicking one of the candidates re-runs that
  action with the chosen value in the field the platform named: no model call, nothing billed, and no
  chance of the answer routing somewhere else. The rule that comes with it binds any action added
  later: a candidate has to be a legal VALUE for the field the question names, or the person is being
  offered an answer the next turn refuses.
  
  `BoardService.addServiceFromRepo` now answers with the frame AND the disposition that produced it
  (`created` or `mounted`), an internal signature change with no wire effect. The account-wide dedupe
  answers with a frame either way, and only the operation knows which path it took: a caller comparing
  the returned frame against the board it read a moment ago sees a service homed on another board as a
  fresh import, which is the one case the distinction exists to report.
  
  Two alternatives were considered and rejected. A TOOL-CALLING loop (let the model call the board's
  own methods) would have put the model inside the write path, where a wrong argument is a wrong write
  rather than a wrong question, and would have made "which service did you mean?" unanswerable without
  a second round trip. A DEPLOYMENT-REGISTERED action catalog was left for a later step: every action
  performs a board write through an engine-internal service, the same reading that keeps the `merger`
  step resolver a privileged built-in, so opening the catalog means defining a public, minimal action
  context first. The tracker holds it as a named phase.
  
  Worth watching when reviewing:
  
  - The assistant is member tier and mounts no permission gate, on the same reading as the bug hunt:
    every action it performs is board authoring a member can already do from a button. Each write
    carries the asker's own tier (`blockEditAuthority`), so it is never a way around a policy its user
    is held to.
  - A turn is a billable model call no run start gates, so it answers to the workspace budget
    (`isOverBudget`) before any vendor is reached, and fails closed.
  - `WorkspaceService.snapshot` was refactored (no behaviour change) so that its board composition and
    the two visibility passes are one private method, and a new `boardBlocks` read shares them. That
    keeps exactly one definition of what is on a board while letting a caller that needs only the
    frames skip the workspace's pipelines, executions and three built-in catalogs.
  - There is no conformance group, and the reason is in the doc rather than an omission: the module is
    composed in `createCore` from dependencies every facade already provides, with no port
    implementation, table, migration or cron of its own. Making an end-to-end turn assertable per
    facade needs an `AssistantRouter` seam first, which is on the tracker.

## 0.349.0

### Minor Changes

- 5f06bfb: Run an environment dry run on the model the workspace picked, and hand it what the tester will get
  
  An agent dry run was dispatched on a model no workspace had chosen. Its facades read the deployment's
  env routing for the tester kinds once, at wiring, and pinned the prober to it for the process
  lifetime, so a workspace running everything on its Claude preset had its dry run dispatched at the
  Node family's Qwen default. The LLM proxy then refused it for having no key configured (`502`), after
  the run had already created a branch and stood a real environment up. The subscription that would
  have served it was never asked for, because the flow only ever knew the proxy branch: a
  subscription-routed model was refused at WIRING, which disabled the whole capability for exactly the
  deployments that had one.
  
  The model is now resolved per dispatch, under the same precedence a pipeline step gets (the frame's
  own pin, then the workspace's model preset entry for the prober's kind, then env routing), through
  the shared `ModelRouter`. The credential that opens it comes from the same `ContainerJobAuthResolver`
  the step executor uses, so a dry run can run on a pooled subscription, a personal one, or the
  developer's own CLI in native local mode. A personal credential is only leasable with its owner's
  unlock, so the start route gates on it exactly as a run start does (428 `credential_required`, minted
  against the run id the dispatch leases against) rather than provisioning an environment and failing
  at the lease. `provision` mode spends no model call and stays ungated.
  
  The dry run also now predicts what a tester step will be handed, which is the only thing it was ever
  claiming. Both are rendered by one module: the frame's test credentials as a three-state brief
  (configured / the platform could not open its own store / this deployment has no store), the
  environment access scheme including the two states the tester's own section used to drop, and one
  list of where to look in the repository for how to operate the service. The tester side of each was
  weaker: a sealed store that would not open reached it as an absent section, which reads as "this
  service has none configured" and sends someone to re-enter secrets that are already there, and an
  unopenable store took the whole dispatch down rather than costing the credentials.
  
  One rule the two held halves of moved with them: the shapes of a success nobody observed (a 200
  carrying an error body, a login page where JSON was expected, a command that printed failures and
  exited 0, a suite that ran zero tests). The prober named the HTTP ones; the tester, whose greenlight
  is what merges a change, had the principle and none of the shapes. Grading and writing deliberately
  did NOT move, because a prober never does either and the second is a security property its dispatch
  shape enforces.
  
  Watch for one behaviour change: a dry run used to run on the deployment's `tester-api` /
  `tester-ui` env routing, and now runs on whatever the workspace's preset names for
  `environment-prober-api` / `environment-prober-ui`, falling back to that same env routing when the
  preset names neither. A deployment that wants a specific model for dry runs sets it on those two
  preset entries. The proxyable check moved with the resolution: it is asked of the RESOLVED model at
  dispatch instead of disabling the capability deployment-wide over a routing entry no workspace had
  chosen.
  
  Three things the dispatch resolves are now PERSISTED on the run row and handed back to every later
  poll (`probe_model`, `probe_subscription_token_id`, `probe_subscription_vendor`), the same rule a
  pipeline step's `recordDispatchAttribution` follows. The poll runs in a fresh process and rebuilds
  its handle from that row: re-resolving the model there answered about the frame and preset as they
  are NOW, so a pin cleared while the container worked stamped the settled report with a model nobody
  ran, and the leased pooled token id has no second source at all.
  
  With it, a settled dry run files what it spent through the same `ContainerJobAccounting` a step's
  poll files through: the per-call rows, the leased token's usage-aware rotation counters and the
  modeled quota cycle. That only binds on a subscription harness, which is why it could not be left
  out: a Pi job is metered by the LLM proxy, but a subscription harness talks to the vendor direct, so
  the whole burn of a subscription-routed dry run was previously absent from the telemetry, from the
  rotation and from the quota window: free and invisible, on the flow whose own admission gate is a
  budget.
  
  Admission now also asks whether the RESOLVED model can be dispatched (409
  `env_test_probe_model_unavailable`, translated in every locale), covering a provider the LLM proxy
  cannot serve and a subscription-only model with no connected credential. Both were knowable before
  anything was created and both used to cost a throwaway branch, a full provision and a teardown to
  discover. The personal-credential unlock moved to LAST among the gates, resolved through a closure
  the service calls after its own refusals, so a dry run that could never have started no longer asks
  for a password first; and the mint now happens before the run row exists and outside the start's
  cleanup path, so an unlock that fails answers `428 credential_required` instead of a `201` carrying
  a failed run that the SPA reads as a finished action.
  
  Two fixes reach beyond the dry run. The modeled subscription quota cycle is now keyed on the VENDOR
  the dispatch resolved rather than the model's provider: the two differ for four of the five
  (`claude`/`anthropic`, `codex`/`openai`, `glm`/`zai`, `kimi`/`moonshot`), so the fold silently
  matched DeepSeek alone and counted nothing for the rest. Expect quota cycles to start reporting
  usage for those vendors. And both facades now compose every container dispatch's credential channels
  through one builder, which is what closes the gap the dry run's own composition had: it omitted
  `resolveAccountId`, so the proxy session token carried no account scope and the account-tier spend
  budget was not enforced for a dry run while it was for every pipeline step.

## 0.348.0

### Minor Changes

- 8dc6677: Test whether an agent can actually operate a service's ephemeral environment, before a pipeline finds out
  
  "Test environment creation" answers whether a service's provisioning stands an environment up and
  takes it down again. The expensive failure is the one after that, and it is a GREEN deploy: the
  environment is up, the tester reaches it, and the agent then spends its whole step
  reverse-engineering an auth flow, guessing a base path, or reporting the service as broken because
  nobody told it which credential to send. That is a full run spent to discover a missing sentence of
  configuration.
  
  "Test agent dry run" sits beside it on the same service and buys the same finding for one
  container. It runs the identical lifecycle against a throwaway branch and adds one stage in the
  middle. The environment is handed to an agent (HTTP for a backend service, a browser for a
  frontend frame) together with the frame's sealed test credentials, the provider's own access
  handle and a read-only checkout of the branch the environment was built from. The agent picks a few
  simple but meaningful operations, at least one of which must go through authentication, attempts
  them, and reports each one: what it was, how it was performed, whether it exercised auth, and what
  happened. Then the run tears the environment down and deletes the branch exactly as before.
  
  The report's most valuable field is the one listing what the PLATFORM failed to supply (a
  credential with no reference, an endpoint that could not be discovered, an auth flow that had to
  be reverse-engineered), because each entry is a thing to fix before a real run spends a step on
  it. An operation the agent could not even attempt is a first-class outcome carrying the reason,
  not a failed call, and the failure vocabulary is grouped by whose problem each kind is: "no credential
  was supplied" and "the credential I was given was refused" are different fixes and therefore
  different members.
  
  The verdict is computed by the platform from the agent's per-operation judgements, never read off
  the reply, and it will not call a service operable unless something that worked went through
  authentication: a healthcheck answering 200 proves an ingress exists and nothing about whether an
  agent can work there.
  
  Two things to watch when reviewing. The run's `status` deliberately stays a statement about the
  LIFECYCLE, so a dry run reporting `inoperable` is a SUCCEEDED run that found something. Folding
  the verdict in would make the one interesting outcome indistinguishable from a broken diagnostic
  and leave a real teardown failure with nothing to say. And everything knowable before the first
  side effect is refused there rather than mid-run: a deployment that cannot drive a dry run at all,
  one whose runner backend has no image for THIS frame's surface, a workspace over its spend budget,
  and a frame that already has a self-test running. Each of those otherwise costs a branch, a full
  provision and a teardown to discover.
  
  Internal break: `environment_test_runs` gains `mode`, `probe_surface`, `probe_dispatched_at`,
  `probe_progress` and `probe` on both runtimes, and the start endpoint takes an optional `{ mode }`
  body (absent is the provisioning self-test, so an existing client is unchanged). The reasoning, the
  traps and the wiring: `backend/docs/environment-self-tests.md`.

## 0.347.0

### Minor Changes

- 76e2c1d: Bug-fishing expeditions now partition a large codebase into TERRITORIES and fish each angle over
  each one, instead of telling every pass to decide for itself where an angle could bite.
  
  The partition is computed by the platform from the repository tree (blueprint modules first, then
  package and directory boundaries, sized by blob bytes), the expedition stays ONE run whose phase
  list is territory x angle, each pass is handed its territory's manifest as a `.cat-context/` file
  so it starts from a map rather than three greps, and what each pass reported reading becomes a
  per-phase coverage record. A pass budget bounds the matrix and every cell it cuts is recorded as
  unfished. A codebase small enough to fish whole runs exactly as before.
  
  Territories are computed and stated in the frame the AGENT works in: the service's own directory
  in a monorepo, which is where the harness roots its checkout, rather than the repository root.
  
  A task-type field descriptor gains `integer`, so a `number` field whose value must be whole says so
  where a caller can read it instead of being refused at creation with a raw schema error. The public
  API spec moves to 1.70.0 for it; `review.prNumber` and the new `bug-fishing.fishingMaxPasses` both
  declare it.
  
  Internal wire break: `GitHubClient.listTree` and `VcsClient.listTree` now return
  `{ entries, truncated }` rather than a bare array, so a caller building a manifest can tell a
  truncated tree from a complete one. `bug-fisher` switches to `standardsDelivery: 'context-files'`,
  so its standards are read once from `.cat-context/` instead of re-sent on every turn of every
  pass.

## 0.346.2

### Patch Changes

- 5c50d30: Cleanup pass with no behaviour change: deletes exports nothing consumed (dead constants, parse
  wrappers, alias schemas, pass-through re-exports and the Worker's compat-shim modules left over
  from the `@cat-factory/server` extraction), drops the `export` keyword from module-local symbols,
  folds duplicated private helpers onto one owner (base64, `scrub`, `sleep`, `withFlag`, the
  per-row busy guard), and removes tests that asserted a constant against its own literal or
  re-implemented the code under test. The SPA's unreachable palette drop handler goes with it.
  
  Internal-surface break, flagged per the compatibility rules: the removed barrel exports
  (`DEFAULT_CI_MAX_ATTEMPTS`, `STANDARD_PHASES`, `isTestingKind`, `isBugFishingPhaseId`,
  `SEALED_SECRET_SOURCE_NAMES`, `TelemetryReadResults`, `LinearFetchLike`, `ENVIRONMENT_BLOCK_TYPE`,
  the contracts `parse*`/`safeParse*` one-liners and the `initiativePreset*`/`taskTypeFieldOption`
  schema aliases) had no consumer in this repository; a downstream import of one of them fails at
  typecheck and should read the underlying helper directly.

## 0.346.1

### Patch Changes

- d36d0a8: Reach the bootstrap's reference template the way the clone reaches it, and pre-flight it
  
  Two components disagreed about what "we can read the reference architecture's repository" means.
  The monorepo adoption survey resolved it through `resolveRepoFilesForCoords`, scoped to the
  workspace's PROJECTED repos, while the apply phase cloned it with the installation token. A
  reference architecture is an admin-managed `owner/name`, not a repository the board links, so the
  ordinary case surveyed as unread while the clone worked: every adoption decision showed the
  template as "unverified", which reads to a reviewer as a template with no opinion rather than as a
  template nobody opened. `RepoBootstrapper.resolveReferenceRepo` is now the one answer, and it is
  the bootstrapper's, so the survey and the clone agree by construction.
  
  The same call is a pre-flight. A run naming a reference architecture whose repository the
  connection cannot see is refused before any row is written, with `reference_repo_not_found` (422,
  the entry is wrong) or `reference_repo_unreadable` (503, the provider is down) rather than a job
  row, a provisional board card and a failure a phase later. It also binds the retry, so correcting
  the entry and retrying is the way out with every other value of the run intact.
  
  Two clone bugs fall out of resolving the template properly: a new-repo run scoped its job token to
  the target alone, so a PRIVATE template was uncloneable, and it assumed the template's default
  branch was `main`. Both surfaced as bare git errors. The scope goes through the shared
  `jobTokenRepoIds`, so a template that IS the run's own target is asked for once rather than twice,
  and a mint GitHub refuses (`repository_ids` may only name repositories the installation holds,
  which reading a public repository does not prove) is reported naming the repository to grant.
  
  The bootstrapper is also told which provider its client speaks, so a workspace connected to
  another one is refused as unconnected rather than probed with the wrong credential and reported as
  a reference architecture naming the wrong repository.
  
  Behaviour change worth noting on `POST /api/v1/repos/bootstrap`: it delegates to the same service
  method, so it gains the same refusals, as a 422/503 rather than a `failed` creation in the 201.
  The public surface version moves to 1.68.0 and `backend/docs/public-api.md` documents both.

## 0.346.0

### Minor Changes

- 0f3fb10: Bootstrap runs are legible: their steps are shown, their details are inspectable, and a retry resumes where the run stopped
  
  A repo bootstrap was already a first-class agent run in every way that costs something to build
  (one `agent_runs` table, one retry surface, one stop surface) and in no way that helps a person
  watching one. It rendered as a single "bootstrapping…" bar, so a monorepo bootstrap's three moves
  (survey both repositories → your adoption decisions → write the service and open the pull request)
  were invisible, and the control under that bar said "Retry bootstrap" while the service actually
  resumed at the phase the run reached, carrying the reviewer's settled decisions forward.
  
  The steps are now derived from the run row by one rule in `@cat-factory/contracts` that both sides
  read: the board renders them on the in-progress, parked and failed cards, and
  `BootstrapService.retry` branches on the same function, so the button names the step it resumes
  from and cannot promise one the service does not re-enter at. Where a run GOT to and where a retry
  RESUMES are separate questions, because they differ on one case: a run parked on a plan the
  platform could not produce reached the review, but the retry drops that plan so a fixed deployment
  can produce a real suggestion, and re-surveys.
  
  A bootstrap is also inspectable through the observability panel now, over the same routes and the
  same four sinks as any other run. It had been filing almost nothing: no provided-context snapshot,
  no tool-call trajectory, and its apply phase's model calls keyed on the run's DRIVE id, which no
  run-scoped read asks for. The drive id now addresses the container and nothing else; every sink
  carries the run. The inline monorepo survey tags its loop with the run too and files its own
  context snapshot, so its prompt and its spend read beside the apply's instead of sitting in the
  store outside every read that could find them. What the panel cannot answer for a bootstrap (the
  per-phase rollup and the run's cost, both folded from an execution's steps) it now SAYS, rather
  than hiding the section: beside a list of calls that plainly cost something, a missing cost tile
  reads as a run that cost nothing.
  
  Stopping a bootstrap no longer reports itself as a failure of the step it was stopped in. A stop
  is stored as a failed status with a `cancelled` kind, so a stopped monorepo run used to paint the
  reviewer's own decision step red; it is now its own step state.
  
  Two behaviour changes worth knowing: a bootstrap's model calls are filed under the agent kinds
  that actually ran (`repo-bootstrapper`, `monorepo-adoption-advisor`) rather than under `architect`,
  which changes how new rows group in per-kind spend rollups (the container still resolves its MODEL
  through `architect`'s routing); and `MonorepoAdoptionSubject` gains a required `runId`, so a
  deployment that injects its own `MonorepoAdoptionAdvisor` implementation gets the run id it needs
  to tag its calls with. The two kind strings are exported from `@cat-factory/contracts`
  (`REPO_BOOTSTRAP_AGENT_KIND`, `MONOREPO_ADOPTION_AGENT_KIND`), which is where anything naming
  them should now read them from; `@cat-factory/agents` no longer exports the second.

## 0.345.0

### Minor Changes

- 745eae8: Let a bootstrap say how its work should land: a pull request, or a push.
  
  A bootstrap's delivery used to be decided by its target. Landing a service in a monorepo always
  opened a pull request; creating a repository always force-pushed the scaffold onto the default
  branch. Neither is wrong as a default and both are wrong as the only option: a team that wants
  the first commit of a new service reviewed before it becomes `main` had no way to ask for that,
  and a team standing services up in their own monorepo had to review and merge a pull request per
  service to get one there.
  
  `delivery` (`pull_request` | `direct_push`) is now a third axis on the launch form and on
  `POST /workspaces/:ws/bootstrap/jobs`, orthogonal to where the content comes from and where the
  service lands. Omitted, it resolves to the target's own default, so every existing caller is
  unchanged: `direct_push` for a new repository, `pull_request` for a monorepo. It is stored on the
  run, because a retry re-dispatches under it.
  
  Three consequences worth knowing before choosing:
  
  - **`direct_push` into a monorepo publishes as the agent works.** The harness checkpoints
    committed work to whichever branch it is pushing, so a run that faults leaves what it had
    already written on the default branch. A retry resumes on top of it.
  - **`pull_request` for a NEW repository needs a base commit**, since a pull request is opened
    between two commits. A repository with none is refused at pre-flight, naming both ways out.
    Create it with an initial README, or push directly. The modal's own "create repository" button
    now seeds one.
  - **A `pull_request` run does not trigger the initial service mapping.** The mapper clones the
    default branch, which such a run has not written to, so it would map the repository's initial
    README. The service frame says so; run "map service" from the inspector once the pull request
    has merged.
  
  `/api/v1`: a bootstrap job now projects `delivery`, and its already-released `prUrl` is populated
  for a new-repo run that opened one. Read `delivery` for whether a pull request is coming and
  `repoUrl` for which target a run took; the two URL fields are no longer mutually exclusive. Spec
  version 1.68.0, additive, all four SDKs regenerated.
  
  Internal break: `MonorepoBootstrapLeg` no longer carries `branch`/`pr`, and `BootstrapRepoRequest`
  carries a required `delivery` plan instead; `monorepoBootstrapBranch` / `monorepoBootstrapPrTitle`
  are now `bootstrapWorkBranch` / `bootstrapPrTitle`. A bootstrap run also records its `workBranch`,
  so a retry resumes the branch its first attempt pushed instead of opening a second one.

## 0.344.0

### Minor Changes

- e7e1f8c: Bug fishing expeditions: hunt a codebase for the defects nobody has reported yet
  
  Every defect flow the platform had started from a REPORT: `bug-investigator` triages one,
  `pl_bugfix` fixes one, `bug-hunt` picks one off a tracker board. Nothing looked for the defects
  nobody has hit, and those are the ones that surface as an incident rather than as a ticket.
  
  A new `bug-fishing` task type runs the new read-only `bug-fisher` agent over a service's codebase
  once per ANGLE — logic and control flow, failure handling, boundary conditions, concurrency and
  idempotency, state and resource lifecycle, interface contracts, footguns, and conformance with the
  supplied product requirements. One pass told to find everything returns the shallow half of
  everything; a pass told to think only about concurrency reads the same files with a question that
  makes the race visible, and each angle is its own dispatch with a fresh context, so one angle's
  reading never lands on another's transcript. Nothing is written and no pull request is opened.
  
  Triage does not wait for the hunt. A finished angle's findings are final the moment they land, so
  the expedition window offers them while later angles are still fishing, and each finding a human
  MARKS spawns its own bug-fix task — carrying the finding's evidence and reproduction — on the
  pipeline the board configures for spawned fixes (`bugFishingFixPipelineId`, defaulting to the
  built-in bug-fix preset, overridable per batch). The spawned task links back through the new
  `Block.expeditionId`.
  
  Refusals are deliberately loud rather than convenient. A pass that crashes settles THAT angle as
  failed carrying its reason, and so does one that answers unusably (no `result.custom`, or a blob
  the schema rejects), because a phase that silently reported nothing is indistinguishable from one
  that honestly found nothing — and which angles came back empty is the whole thing a human reads.
  A mark whose fix task cannot be created — a pipeline that no longer exists, or one that cannot be
  started on a one-off task — fails with the pipeline named instead of answering 200 and leaving
  somebody waiting for a task that will never appear. Dismissing an id the expedition does not carry
  is refused rather than quietly accepted. And an expedition that caught nothing still parks and
  says so.
  
  Marking is safe against two people at once. Creating the task and recording it after would let two
  markings of one finding each file the same bug and start a run for it, so the finding's spawn
  record is taken as a `pending` CLAIM under the run's compare-and-swap, carrying the block id it is
  about to create, and settled to `spawned` or `failed` behind the work. The consequence for anyone
  reading the state: whether a finding is being fixed is its spawn's `status`, not the record being
  present. A spawned fix is also created the way the create form would have created it — with the
  service's standing standards and the marking user as its creator — so it is held to the same
  standards as the identical bug filed by hand, and the notifications its run raises reach somebody.
  
  The pre-dispatch input gate learned about the type: a bug-fishing task legitimately carries no
  description, because its input is the codebase, so `description_missing` no longer parks one at
  step 0.
  
  Public API: `taskType` gains `bug-fishing` and `NotificationType` gains `bug_fishing_triage`,
  with two new optional notification-payload fields (`phaseCount`, `untriagedFindingCount`). Both are
  additive enum members the SDKs already tolerate; the spec is `1.67.0`.
  
  Internal break: `workspace_settings` and `blocks` each gain a column, and
  `ExecutionServiceDependencies` gains an optional `serviceRepository` plus an optional
  `promptFragmentSource` (the pool a newly created task's default fragments come from, so a spawned
  fix reads the same one the create form does). Both facades ship the migration.
- a1802d9: Report what the platform tried about a failed environment, instead of reporting only that it failed
  
  Both remediation loops a `deployer` step can run recorded everything on the step and nothing
  reduced either into the verification report. So a run whose environment failed, was diagnosed as a
  provider fault, was restarted in place and then came up served byte-for-byte what a run with no
  remediation loop wired at all serves. Nothing outside the backend could establish that the loop
  had run: a headless suite reading the report, the one provider-neutral surface it has, had no
  observable to assert on, which made the feature unfalsifiable from outside the deployment.
  
  `environments.entries[].remediation` now carries the DECISIONS, per frame. `deployFix` counts the
  `deploy-fixer`'s repair rounds against the cause it was dispatched for and splits the rounds whose
  job FINISHED from the ones that died having changed nothing in the checkout, because a bare round
  count reads as the first. `investigation` carries the layer the last verdict blamed, the action it
  asked for, every action the engine actually RAN, why a requested action was withheld, the
  investigation's own failure when a round produced no verdict, and how many readiness-ceiling
  extensions a `wait` verdict won: a granted `wait` is the one remedy that otherwise leaves no trace
  anywhere, since the bring-up simply runs past the configured ceiling and the timeline beside it
  cannot be reconciled without it. The investigator's summary paragraph and cited evidence stay on
  the run's own record.
  
  Three absences stay distinct: no `remediation` means neither loop ran, a null `faultLayer` means no
  round produced a verdict (never the `unknown` LAYER, which is a verdict reached on evidence that did
  not settle the question), and an empty `ranActions` means nothing ran, with `withheld` saying why.
  There is no field for whether the remedy WORKED, on purpose: that is the deployer's next verdict,
  which `entries[].status` already states. `@cat-factory/acceptance-kit` gains
  `checkEnvironmentRemediation`, the reduction that asserts the loop ran and settled on a fault layer.
  
  Fixes a defect the new section would otherwise have under-reported, and one bug beside it. A
  loop-back to a `deployer` step (the `human-test` gate rebuilding the environment a person is
  testing) dropped the whole of `step.deployFix`, so a frame whose deployment files the fixer had
  machine-edited reported as one nothing was ever attempted on; and `step.environmentInvestigation`
  had no reset at all, so the looped-back step carried a SPENT budget into its next failure, refused
  the first round of the new cycle as "the budget is spent", and explained the terminal failure with
  the verdict about the environment the re-provision had already superseded. The counters of both are
  now re-armed per provisioning CYCLE and the attempt logs survive the RUN, which is what the report
  reduces.
  
  Splitting those two lifetimes is what every remaining decision here follows from. Each attempt row
  carries the CYCLE that ran it, so a read scopes itself explicitly instead of taking whichever
  half is nearer: the live budget and the last verdict are read within the CURRENT cycle (a verdict
  from a superseded cycle diagnoses an environment the re-provision destroyed), while the report
  reduces the whole log and states `cycles` beside `attempts` rather than printing a run-long count
  against a per-cycle budget. `waitExtensions` is the one counter that stays RUN-long: a cycle is
  not always started by a person or a gate, since `rerunProducerThrough` is driven by the judge loop
  and the below-threshold companion loop too, and a per-cycle bound would hand the model a fresh
  readiness ceiling on every automatic rework round. Both logs are now capped and count what they
  drop, since they live in the run's compare-and-swapped JSON blob.
  
  Internal break: an attempt log's `attempt` is now its ordinal in that run-long log rather than a
  copy of the live cycle counter, and each row carries a `cycle`. The two ordinals are identical on
  any run that never loops back to its deployer, and only a stored step carries the fields.
  
  Additive on `/api/v1` (spec `info.version` 1.66.0): new optional and required fields on a response
  object introduced in the same release, plus a fourth `entries[].status` value, `unsettled`, for the
  frame whose recorded outcome a remediation loop cleared to re-provision it. The clients ignore
  unknown fields and tolerate unknown enum values, so a consumer built against 1.65.0 keeps parsing.

## 0.343.0

### Minor Changes

- 3b11b10: Give the runner image's nested containers a network again, and measure it before claiming one
  
  The image started its rootless daemon with `--iptables=false` unconditionally. That flag arrived
  because the daemon could not start at all without it in a sandbox like Cloudflare Containers, and
  it did fix that. What went unnoticed is what it costs once the daemon DOES start: the rule it
  drops is the MASQUERADE for the bridge, so traffic from a nested container is never NATed and the
  container has no egress whatsoever, no DNS and no raw IP either. The daemon's own `docker pull`
  keeps working, which is most of why it stayed hidden, and the cost lands on the thing agents do
  constantly. On the run that exposed this, a coder's first `docker build` spent 426s inside
  `RUN npm ci` before failing, and from outside it read as a hang: the heartbeat stayed fresh,
  `lastActivityAt` moved, and nothing was logged between the job starting and the failure.
  
  The flag is now a fallback rather than a premise. The entrypoint starts the daemon that manages
  its own firewall rules and only starts the crippled one when the first one EXITS without serving,
  which is the one piece of evidence that is actually about its flags: a sandbox with no iptables
  binary and no NAT module does not slow the daemon down, it makes `dockerd` exit at once. A first
  arm that is merely slow keeps the rest of the readiness budget, because a clock says nothing about
  firewall rules and swapping there would take a capable daemon away from a cold sandbox for the
  container's whole life; a first arm that never answers is recorded as undecided and LEFT RUNNING,
  so `resolveDockerVerdict`'s live re-probe can still find it, with its NAT. A sandbox that genuinely
  cannot do iptables ends up exactly where it was; a privileged Docker or Podman host, which is what
  local mode runs on, gets working nested networking.
  
  Each arm gets its OWN rootlesskit state directory, image store and pid file, and the abandon path
  waits for the process to be gone after `kill -9` rather than returning the moment the parent is
  reaped. Both matter for the same reason: SIGKILL is not propagated, so a launcher that had already
  forked the real `dockerd` dies while its child holds a lock on the shared data root and a live pid
  file, and the replacement then fails for a reason that has nothing to do with why it was started.
  That is the worst outcome available here, since both arms record `failed` and the container ends up
  with no daemon at all where before it had a working crippled one. The two arms record different
  `reason` words, and the fallback's detail states only what was OBSERVED (the first daemon exited)
  rather than naming iptables as the cause, which nothing in the entrypoint measures; the real cause
  is the daemon's own log tail, which now rides the stderr line announcing the switch.
  
  The other half is that nothing could see this. The container check runs a container, which is
  strictly better than asking the daemon about itself, and it still cannot see a daemon whose
  containers have no network, because loading and running a local image needs none: the harness
  reported `dockerDaemon: "usable"` on every published image and told each agent, as stated fact, in
  a block that also says not to spend turns re-checking it, that `docker build` works there. So a
  `usable` verdict now carries what a SECOND container, on the default network, could reach:
  `reachable`, `blocked` (with a detail separating no route at all from a route with broken DNS) or
  `undetermined`. It rides `GET /health`, the agent's environment inventory and the Tester step's
  own `infraSetup.dockerEgress`, so the record a human reads no longer shows the same
  undifferentiated `usable` for a daemon whose containers cannot fetch anything. Which commands the
  inventory claims now comes FROM that verdict rather than being stated and then retracted one
  sentence later, and the `blocked` wording is precise about which break, since the daemon does still
  pull base images and only the `RUN` lines that fetch from the public internet fail.
  
  Same asymmetry as the daemon verdict: a busybox without the applet, an unreadable target setting, a
  container that printed nothing and a daemon that refused to start the egress container at all are
  facts about the platform's own check and are never reported as an absent network, and a name that
  resolved while the configured address was refused is undetermined rather than blocked, because a
  deployment that filters that address is likelier than one with no route. An undetermined verdict
  now says whether asking again could ANSWER differently: a timeout is re-measured, while a rejected
  setting, a payload with no `nc` and a filtered address are latched, because re-running two
  container starts and an image load per job never converges on a cause that cannot change under a
  running container.
  
  The connect probe no longer reads a bare `nc -w` exit status as evidence. busybox documents that
  flag as the timeout for connects AND FINAL NET READS, so a connect that SUCCEEDED to a peer which
  expects the client to speak first (every TLS port, the default `1.1.1.1:443` included) hits the
  alarm and exits non-zero, which is indistinguishable from a refusal. It uses `-z` where the
  payload's busybox has it and no `-w` where it does not, and wraps both halves in `busybox timeout`.
  
  New knobs, all optional: `HARNESS_DOCKER_EGRESS_TARGET` / `HARNESS_DOCKER_EGRESS_DNS_NAME` aim the
  egress check somewhere a restricted network permits, which is what a deployment with an internal
  mirror and no public egress should set. `HARNESS_DOCKER_READY_TIMEOUT_SECONDS` keeps its meaning as
  the budget for the WHOLE sequence rather than gaining a per-arm sibling.

## 0.342.0

### Minor Changes

- 9dfd40b: Let the monorepo adoption survey choose what it reads, and record what it read.
  
  The survey behind a monorepo bootstrap's adoption suggestion used to read a DECLARED list of
  files (the root convention files, up to two CI workflows, one probed sibling service) and hand
  them to one model call to judge. What the survey could not see was therefore decided before it
  looked. It could see a sibling's dependency on `@acme/service-base` but not what adopting it
  entails; it could name one sibling but had no shape in which to say the siblings disagree; it
  saw nothing below a sibling's top level; and it read whichever two CI workflows sorted first,
  which is unlikely to be the one that will actually gate the pull request.
  
  The read is now a bounded tool loop. The platform still seeds an opening context (each side's
  root listing and convention files, whichever CI declaration the repository's provider uses
  listed rather than sampled, and the listing of every sibling holding a convention file of its
  own), and the model then asks for what it needs through `list`/`read` tools bound per side over
  the same checkout-free `RepoFiles`. It is still inline: no container, no clone, no runner-image
  change. The prompt is built from the sides that were actually wired, so a run whose reference
  template the workspace never linked is not told it has tools it does not have.
  
  The platform keeps the bookkeeping, which is what keeps the suggestion checkable. Every read,
  seeded or model-chosen, is budgeted (24 model reads, 54 000 characters for the loop), scrubbed
  of secrets and appended to one transcript, and a recommendation citing anything that transcript
  does not hold as read is still dropped and reported. Exhausting a budget is stated to the model
  so the plan can name the areas it ran short on, and reported on the plan so a reviewer can tell
  a thin read from a thin reading.
  
  `AdoptionSurvey` is now that transcript: `reads` replaces `monorepoPaths`/`templatePaths`/
  `unreadablePaths`, `siblingServices` replaces the single `siblingService`, and `exploration`
  carries the budget plus `recordsDropped`, the count of rows the transcript's own cap could not
  hold. `reads` is nullable: the list projection every workspace snapshot is built from withholds
  the transcript once a run is past its review, and says so rather than sending an empty array,
  which is what a survey that read nothing looks like. Internal wire shape, so a plan stored by an
  older build reads back unusable and the run should be retried; nothing about the review, the park
  or the pull request changes.

## 0.341.0

### Minor Changes

- 1c79070: An environment provider can state a balancer by NAME, and the platform resolves it when it dials
  
  A route candidate had to be an IP literal, on the reasoning that "a name would just be the lookup
  that already failed". That is true of the environment's own hostname and false of the name the
  deployments this feature exists for actually have: a per-PR environment whose record lives in an
  internal view is fronted by load balancers that are ordinary public names, and those names resolve
  from anywhere. A provider had to resolve them itself and state the result, which pins a snapshot of
  a set that rotates as the balancer scales, forces DNS into a pure response mapping, and asks every
  such provider to get bounded resolution and partial failure right on its own.
  
  A candidate may now state `host` instead of `address`, and a manifest declares one through the new
  `response.hostsPath` beside `addressesPath`. The platform resolves each stated name at the moment
  it dials, expands it in place into the addresses it answered with (so the provider's preference
  order still means what it says), and grades every one of those addresses by exactly the rule that
  governs a stated address, so an address a bridge may not name is still refused and the destination
  a container is bridged to is still a literal the platform itself proved. The proof publishes the
  address that carried plus the name it came from, and the stored candidate stays the stable identity
  rather than today's answer, which is also what lets a proof survive the balancer changing addresses.
  
  Which kind a candidate names is stated, never inferred from the value. The address rule refuses
  `2130706433` precisely because it is loopback in a disguise, and a resolver handed the same string
  answers loopback without complaint, so a bare string means an address under `addressesPath` and a
  name under `hostsPath`.
  
  Every way a name fails to become an address is recorded as its own attempt rather than dropped: a
  name that resolves nowhere rules that candidate out and the proof moves to the next, a lookup that
  failed (or a resolver that rejected, which the port forbids and nothing can enforce) carries the
  resolver's own words, and a deployment with nothing wired to resolve records the new
  `resolver_unavailable` reason, which settles nothing either way and can never fail a frame. Both
  facades wire a resolver (Node through `dns.lookup`, the Worker over DNS-over-HTTPS, which is the
  view its own outbound connections already resolve through).
  
  The platform also says when it stopped reading: the plan bounds how many names it looks up and how
  many addresses it dials, and a list longer than that now ends in one `not_attempted` attempt naming
  how many were passed over. That is a second new reason, and it leaves the route unruled-out for the
  same reason the first does. A verdict that nothing reaches an environment may not be graded against
  candidates nobody looked at, and the deployer fails a frame on that verdict.
  
  Two proofs that used to stand forever are now re-taken by the status poll: one recording that this
  deployment could not resolve a name (once one is wired), and a `reached` proof whose address was
  RESOLVED rather than stated. The second is the price of surviving a balancer rescale, which is what
  `viaHost` is for: the name stays good while the literal beside it, the one a container host bridge
  is built from, can be released by the same scale event.
  
  Internal breaks, no migration: `EnvironmentAddress` / `environmentAddressSchema` are renamed to
  `EnvironmentRouteCandidate` / `environmentRouteCandidateSchema` with `address` now optional;
  `planRouteProbes` takes an options object in place of its bare timeout argument;
  `RouteProbeTarget`'s `refused` member is generalized to `undialled` and `recordRefusedAttempt` to
  `recordUndialledAttempt`; and `reduceRouteProof` takes the carrying target rather than its address.
  A stored candidate or proof written before this parses and behaves exactly as it did.

## 0.340.0

### Minor Changes

- 8b015a3: Bootstrap a new service INTO an existing monorepo, with a human review of what it adopts.
  
  Repo bootstrap only ever created a service in a repository of its own: clone a reference
  architecture, adapt it, force-push a single commit to a fresh empty repo. That shape is exactly
  wrong for a monorepo, which already holds other people's services: there is no empty target, the
  force-push would destroy them, and the question worth asking is not what the service contains but
  what it should share with everything around it. A bootstrap can now target a DIRECTORY of a
  repository the workspace already has, and it is delivered as a pull request.
  
  That question has no good default, which is why the run stops to ask. The template ships its own
  build tooling, lint config, test runner, CI wiring and layout; the monorepo has answers for the
  same areas, usually different ones. Adopt the template wholesale and the repository grows a second
  toolchain; adopt the monorepo wholesale and the template stops being worth having. So a monorepo
  run is two phases with a person between them: it surveys both sides, proposes per-area
  recommendations, parks on a new `awaiting_review` status, and writes nothing until a human has
  settled every line.
  
  The suggestion is built to be CHECKED rather than trusted. The platform reads a bounded, declared
  set of files through the checkout-free repo port (the root manifests, the CI workflows, and the
  nearest EXISTING sibling service, which is the only thing that says what a service in this
  repository actually looks like), and the model only judges what it was given. A recommendation
  whose evidence names no file the survey read is dropped before it reaches the reviewer, and the
  plan reports the drop rather than quietly shortening: a plan that lost half its lines to invention
  must not look like a monorepo with few conventions. What the survey could not read is reported
  apart from what is simply absent, for the same reason.
  
  Two refusals are load-bearing. A review that leaves a decision unanswered is refused rather than
  defaulted onto the recommendation, because agreeing with a suggestion and never having read it are
  the two things this step exists to tell apart. And an answer naming a decision the plan does not
  carry is refused whole, since the reviewer was looking at a different proposal. Where no model is
  configured, over budget, or unable to read the repository, the run still parks and the reviewer is
  told what the platform could not offer and why. An empty decision list and "the analysis never
  ran" lead to opposite conclusions, and each cause needs a different fix, so each is its own
  reason. The reviewer can settle such a plan anyway: there is nothing to answer, their notes are
  the whole instruction, and the review is the only exit from the park.
  
  The survey's own model call is guarded twice. It answers to the same workspace budget a run start
  does, since nothing else gates it; and it is claimed atomically before the call rather than marked
  after it, because both durable drivers replay and two drives that each saw no plan yet would bill
  twice and leave a reviewer answering a plan that had been replaced underneath them.
  
  The apply phase is an ORDINARY coding job rather than a bootstrap one: the monorepo as the
  writable primary at a work branch, the reference template beside it as a read-only checkout the
  run is structurally incapable of pushing to, and one pull request. Nothing outside the new
  directory is touched beyond the registration the monorepo's own tooling needs, and nothing is
  merged for the reviewer.
  
  The settled decisions ride the pull request as an engine-owned marker region rather than as its
  body. The harness lets an agent-authored description replace the body field-wise, and it asks for
  one whenever the target repository ships a pull request template, so the reviewed decisions (the
  one thing on that PR the agent did not choose) would otherwise be routinely overwritten. The
  region also means every hole in it crosses the host-markdown boundary: a reviewer's note reading
  "fixes #412" would close an unrelated issue on the monorepo when the bootstrap PR merged.
  
  `BootstrapStatus` gains `awaiting_review` and `BootstrapJob` gains `prUrl`, both reaching
  `/api/v1` (surface 1.65.0) because a run started in the app is read through it. `prUrl` is a new
  field rather than a reuse of `repoUrl`: a monorepo run creates no repository, and putting a pull
  request link in a field documented as the created repository's URL would leave an integration
  that clones what it reads cloning a PR. It is additive (the clients tolerate unknown enum values),
  but a poller's terminal test has to change: `awaiting_review` is neither running nor finished, so a
  loop treating "not succeeded and not failed" as "still working" would wait forever on a run that is
  waiting for a person.

## 0.339.0

### Minor Changes

- ec0aba1: Keep what a status poll observes, and stop the environment investigation reasoning past it
  
  The first real environment investigation produced a confident wrong verdict: it blamed a platform
  readiness gate that had worked correctly, told a human to go change three behaviours that already
  behave as asked, and filed the actual cause as one bullet underneath. Three defects behind it, all
  in what the platform recorded rather than in what the model did with it.
  
  **A status poll now persists what it captured.** `refreshStatus` handed the whole provision-field
  bag to the provider and then wrote a patch that omitted it, so `provision_fields_cipher` was
  written once at create time and never again. For an asynchronous provider the create response is
  the least informative answer it will ever give (no finished deploy job, no load balancers, no
  readiness detail), so every fact worth capturing arrived on a poll and was discarded, and an
  adapter recording its balancer health and DNS resolution on each poll was writing into a field
  nothing read. A stated bag now REPLACES the stored one, whole, and
  `ProvisionedEnvironment.fields` is nullable: `null` states nothing and keeps what is stored, which
  is what stops a status endpoint answering a narrower shape than its create endpoint from erasing
  teardown state. The docstring described merge semantics and the code implemented neither.
  
  The corollary binds every adapter: a statement has to be COMPLETE. The generic manifest provider's
  `status()` therefore carries the keys this response said nothing about over from the stored bag
  under its freshly mapped values, because its bag is built from two paths a status endpoint commonly
  omits (the id usually rides the request path, not the body). Its no-`status`-template fallback and
  the Compose provider's no-project branch answer `null`, which is what an adapter that read nothing
  owes.
  
  **A poll the provider ANSWERED leaves a trail.** The provisioning log records a poll that threw and
  a poll that turned an environment `failed`; any other answer wrote nothing anywhere, so a readiness
  wait that polled for four minutes left two rows a second apart at the create, and nothing in the
  data distinguished "nothing polled" from "polling is not logged". The environment row carries
  `lastPolledAt` plus a `pollCount` floor (a row per poll being the wrong shape at a ten-second
  cadence), both projected onto `EnvironmentHandle`. It counts ANSWERS rather than successes, a
  `failed` verdict included: the claim a reader gets wrong is how much polling happened, and reading
  it as a success count would hand an investigation twenty-two successes for an environment that
  failed all twenty-two.
  
  **The investigation's evidence carries the route, and one timeline.** The bundle gains
  `route` (the addresses the provider stated and what dialling them proved) and folds the proof into
  the timeline dated from its own `checkedAt`, so an ordering claim that contradicts a timestamp the
  platform held is structurally hard to state; the verdict that filed this said the reachability
  check "settled roughly at the moment of the create request" against a `checkedAt` reading 4m18s
  later. The provisioning log's own state is an entry in that list too, in each of the four ways it
  can have one (this deployment keeps none / this environment is on no run / it was read and holds
  nothing / the read threw), because once the record's dates and the poll marker joined the timeline
  an absent log stopped being distinguishable from an empty one by the list coming back short. The
  platform also COMPUTES the determinate cause where its own inputs settle one (a `not_reached` proof
  beside an empty candidate list means nothing but the environment's own name was ever available to
  dial; a `no_candidate` proof BESIDE stated addresses is the different determinate cause that the
  URL published none, not that the provider stated no addresses) and tells the model it outranks
  anything inferred from apparent ordering. Prompt bumped to `environment-investigation@v2`, which
  also forbids reading the absence of an entry in a record of attempts as the absence of the event,
  and names the route evidence and the poll marker as sources an answer may cite.
  
  The route evidence is scrubbed and bounded on the way into the bundle, like every other
  provider-authored section: `candidates` comes off a response mapping with no declared length and a
  probe's `detail` is the only field carrying a raw error string. The attempt list now has ONE
  renderer (kernel's `describeRouteTargets`) rather than a copy per surface, which is how one of them
  came to ship that detail unredacted while its neighbour scrubbed it.
  
  **A route proof survives on what it established.** The fold compared the candidate list as a
  SEQUENCE, so any later poll whose list merely reordered dropped the proof, and nothing took
  another: `proveEnvironmentRoute` is reached only from the deployer's frame settle, which never runs
  again for a settled frame. A provider stating addresses from a live DNS answer does not control
  their order. A `reached` proof now survives while the target it names is still on offer (compared
  after the same trim the prober applies, so a padded address stops failing to match its own proof),
  any other proof while the candidate set is unchanged, and `refreshStatus` re-proves a `ready`
  environment whose proof it had to drop.
  
  The re-prove is bounded, and the bound needed a third field. It runs at most once a minute per
  environment, because a provider that genuinely re-states a different candidate set on every answer
  would otherwise add up to twenty seconds of sequential dialling to every poll of a ten-second
  readiness wait. Pacing that off the proof's own `checkedAt` does not work: the first time the poll
  waits, it persists the drop, and the next poll reads an environment nothing ever dialled. So
  `EnvironmentReachability` carries `probedAt` (when the platform last LOOKED, kept across a dropped
  verdict and a moved URL), which is also what lets an environment settled `unproved` before a
  deployment wired its prober get proved once one exists: `unproved` is a proof never taken, and it
  survives the fold indefinitely.
  
  Internal break: `ProvisionedEnvironment.fields` is `ProvisionFields | null` (nullable, not
  optional, so every provider still has to decide), `EnvironmentRecord` gains `lastPolledAt` and
  `pollCount`, and the stored reachability blob gains an optional `probedAt`. Both facades add the two
  columns (D1 migration 0099 and the matching Drizzle migration) and existing rows read back as
  never-polled, which is what they are; `probedAt` needs no migration (it is inside the existing JSON
  column) and a value written without one re-proves at its first opportunity.

## 0.338.0

### Minor Changes

- 436f373: Find out whether the container's Docker daemon can actually run a container, instead of telling
  every agent that it can.
  
  The harness appended a line to every agent's system prompt saying `docker build`, `docker run` and
  `docker compose up` work here, on the strength of `docker info` exiting zero. Those are different
  facts. A rootless daemon nested inside a sandbox serves happily while its snapshotter cannot mount
  a single image layer, so a multi-layer `docker pull`, a `docker run` of a single-layer image and
  `docker build` all fail on one EINVAL from `mount(2)`. The same block also tells the agent not to
  spend turns re-checking what it states, which made the claim maximally expensive: in the reported
  run the coder, the reviewer and the tester each disproved it separately, and the tester's
  containerised deployment contract went unverified by anyone.
  
  The reachable case is now split by a real workload. The platform assembles a one-layer image in
  memory from a statically linked binary already in the image, loads it and runs a container that has
  to print a marker, so the check needs no registry, no network and no second image. `usable`,
  `unusable` and a daemon that answered while the check could not be carried out are three different
  lines to the agent, and only the first claims the commands work. The asymmetry runs the other way
  too, deliberately: only the container RUN may produce `unusable`, and only where the DAEMON is what
  refused it, so every failure of the platform's own machinery reports that it could not tell rather
  than condemning a working daemon. That covers the steps before the run (no payload on this machine,
  a daemon whose architecture the payload is not built for, a `docker load` that refuses the archive)
  and the halves of a failed run that are ours rather than the daemon's: docker's exit 126/127, a tag
  that did not resolve, a payload that cannot exec there. The image is built for the architecture the
  DAEMON reports, not this process's, because an external `DOCKER_HOST` need not share one.
  
  The weaker fact still decides one case, and it is the one a stale boot record is read against. A
  check that could not be carried out says whether it reached a daemon on the way past, so a
  warm-pool container whose sidecar came up after the entrypoint's bounded wait is not latched into
  refusing local infra for its whole life: a daemon that merely answered overrules a recorded absence
  exactly as the old `docker version` probe did, and only a check that never reached one leaves the
  record to decide. The stand-up refuses on the resolved verdict and names the cause, and the Tester
  step now carries both facts (`infraSetup.dockerAvailable` and a new `infraSetup.dockerWorkload`)
  because the daemon has two ways to stop a stand-up and they are fixed in different places: a
  reachable daemon that cannot run a container, reported as an absent one, sends an operator to
  restart a daemon that is already up. `GET /health` reports the last measurement beside the boot
  record, since `serving` was never the same word as `usable`.
  
  The check is bounded and cancellable, being on the critical path ahead of the clone: one budget for
  the whole pass rather than a ceiling per command, the job's signal on every command it makes, and a
  measurement cancelled once the last caller waiting on it has gone. It answers rather than throwing,
  whatever happens inside it, because the stand-up that consults it is best-effort by design.
  
  The cause is addressed as well as the claim. The rootless daemon is taken off the containerd image
  store, whose snapshotter mounts or fails with no fallback; the graphdriver path it returns to probes
  overlay2, then `fuse-overlayfs`, then `vfs`, and settles on whichever the sandbox permits. That is
  written as a config key rather than a daemon flag, because an unknown key inside `features` is
  ignored while an unknown flag takes the daemon down at startup. Whether it worked is not assumed
  either way: the platform runs a container and reports what happened.
  
  The image also gains the buildx plugin, without which `docker build` and `docker compose build` fail
  before reading a Dockerfile, and a `docker-compose` shim for the spelling half the world's repo
  scripts still use.

## 0.337.0

### Minor Changes

- a745ee2: An environment now carries an address as well as a name, and the platform proves the route before a tester is pointed at it
  
  An environment reached an agent as one nullable URL, so "reachable" meant "a URL exists" and
  nothing between the provider stating it and a tester dialling it ever checked. The tester then got
  `curl` code 000, which covers a DNS failure, a missing route and a refused connection as one
  symptom, and reported the hypothesis its own task made salient: that the environment was down.
  
  Three things change together, because landing any one alone is incoherent or worse than today. A
  host bridge can now map a name to an ADDRESS as well as to the container runtime's host gateway,
  which is what a per-PR environment whose DNS record lives in an internal view needs. The deployer
  DIALS the environment once when its frame settles ready, publishing the candidate that carried
  rather than the first that resolved and recording every attempt either way. And what it proved
  rides the handle into the tester's prompt, so an agent that cannot resolve a name is told which
  layer the platform already ruled out and which address carried.
  
  An environment nothing can reach now settles the frame `failed` with the new
  `environment_unreachable` reason, in about two minutes, rather than being handed on for a tester to
  spend ten minutes and a model budget misdiagnosing. That failing verdict is deliberately the narrow
  one, because a wrong "unreachable" kills a healthy deploy while a wrong "could not tell" costs one
  diagnostic: a probe that could not classify its own failure, an environment with no address to dial
  (a `ready` service that publishes no ingress), and a facade with nothing wired to open a socket are
  `inconclusive` or `unproved`, and neither fails anything. The agent is told when a check was
  inconclusive; a deployment with no prober carries no reachability line at all.
  
  The addresses the platform will dial are limited to those a host bridge may name, applied when the
  probe is PLANNED rather than only when a bridge is built, so a provider-authored address list
  cannot aim the platform's own outbound socket at loopback or a cloud metadata endpoint. A refused
  address is recorded on the proof rather than silently dropped.
  
  Internal breaks, both deliberate: `RunnerDispatchOptions.environmentUrls` becomes `environments`,
  a list of `{ url, address? }` (the pairing is what keeps the host side of a bridge a host the job
  was actually handed), and `planEnvironmentBridges` moves from the local runtime into
  `@cat-factory/integrations`, where the Kubernetes runner transport builds the same bridges as pod
  `hostAliases`. Existing environment rows carry no addresses and no proof, which reads exactly as it
  should: nothing has looked yet.

## 0.336.0

### Minor Changes

- 92232a6: Let a provider say WHY an environment is not ready yet, so the readiness ceiling stops reporting only its own duration
  
  `judgeEnvironmentReadiness` formatted the provider's `lastError` into its `timed_out` message, and
  `lastError` is structurally always `null` on the one status that can reach that branch. Both
  persistence sites write it on `failed` alone and null it otherwise, so every poll that keeps a
  readiness wait alive cleared it and any poll that would have filled it settled the wait as `failed`
  first. The clause was unreachable, and the platform's whole account of a 20-minute wait was that it
  had waited 20 minutes.
  
  The missing thing was not the clause. `ProvisionedEnvironment` had no channel at all for a
  non-terminal explanation, so a provider that could name the stage an environment was stuck at had
  nowhere to put it. `ProvisionedEnvironment.statusNote` is that channel: one sentence, persisted on
  every provision and every poll whatever the status, surfaced in the step's Environment panel while
  the run is parked, in the run outcome's environment row, and in the `timed_out` failure detail.
  
  **A sibling field rather than `lastError` widened to every status**, which was the cheaper option
  and the wrong one. The note is rendered, and under the error's name a healthy environment
  mid-rollout would show an operator a "last error" it does not have. The two are read by different
  readers for opposite reasons and only one of them is a fault, so each keeps its own column and its
  own label wherever it is shown.
  
  **A recorded fault outranks a note on every reader, and neither is ever dropped for the other.**
  The `timed_out` message states both when both are present, fault first, each under its own label.
  The Environment panel withholds the note whenever a `lastError` is recorded, whatever the status
  (a torn-down environment carries the fault of the failure that preceded it), and says nothing
  beside a status that has already left the state a note describes. And where the run OUTCOME's
  environment row shows one of them, it says which: `OutcomeEnvironment.detailKind` is `fault` or
  `note`, because the two arrive through one slot, read identically as prose, and send a reader to
  opposite conclusions. Public API surface 1.63.0, additive.
  
  **The note is bounded where it is written**, not where it is read: provider-authored prose reaches
  three surfaces, and a code adapter answering with a controller dump would otherwise push each of
  them off screen. A capped note says it was capped.
  
  **The note is the current account, never a log.** It is re-read and rewritten on every poll,
  including back to `null`, so a note a provider stops returning stops being stored and cannot outlive
  the state it described. A deployment whose providers never set one keeps today's behaviour byte for
  byte, including the exact wording of both refusals.
  
  The built-in Kubernetes adapter is the first producer, at the two places it already knew and said
  nothing: which Deployments have not finished rolling out (capped, and the cap says it is capped),
  and a workload that is healthy behind an Ingress no controller has routed yet, where the ceiling
  previously reported a bare twenty-minute wait on an environment that had been up for nineteen of
  them. `IngressAdmission`'s `pending` verdict gained the prose that distinguishes its two causes.
  
  Its FAULT channel had the same hole, one status over, and it is closed here too: a rollout that
  gave up and a namespace that no longer exists were both reported as the generic `Provisioning
  failed` literal, though the reduction computing the verdict was holding the workload's own name.
  Both now name what happened.
  
  Watch for: the new `status_note` column lands as a nullable add on both runtimes (D1 migration 0098
  and the Drizzle mirror), and the deployer's projection comparison is now derived from the projected
  object rather than a hand-listed subset of its fields. During a wait the note is the only field that
  moves, so leaving it off the list would have meant the one update the projection exists to deliver
  was the one it never pushed; the TTL, provision type and engine beside it were already in that
  position, and now a field added to the projection joins the comparison with no second edit.
  
  The Node Drizzle schema's ephemeral-environment tables moved into `db/tables/environments.ts` to
  keep `schema.ts` inside its size budget, re-exported so no importer changes.
- a08d2ad: Diagnose an environment that never became usable, instead of ending the run at the tester
  
  A provisioning failure that no edit in the checkout could fix used to be terminal and
  unexplained: the `deploy-fixer` correctly declines every cause outside `manifest_invalid`, and
  nothing else looked. The run died at the tester with a report saying a human had to look, while
  the facts that explained it sat unread in the provider's own response.
  
  A `deployer` step now investigates such a failure. The platform gathers the evidence it already
  had (the environment record, the WHOLE captured provision-field bag rather than the four fields
  a consuming step is handed, and the run's provisioning timeline), asks the provider for its own
  account through a new optional `EnvironmentProvider.diagnostics` capability, and runs one inline
  model call that names the fault layer and picks one remediation from a list the engine narrowed
  first. The engine performs it and the deployer re-enters its own path, so the provider's next
  verdict is what settles the frame. When nothing is worth trying, the run still fails, but with a
  named cause instead of a tester's guess.
  
  The Kubernetes backend implements the new capability: `describe` reads the namespace phase, the
  Deployments' unsatisfied conditions, every pod through `analyzePodStatus`, the namespace's
  warning events and a log tail from each unhealthy pod, and `remediate` rolls the Deployments the
  `kubectl rollout restart` way. Every other provider is unaffected and degrades to the platform's
  own evidence, which it states rather than presenting as an absence of problems.
  
  Internal break: `EnvironmentProvisioningServiceDependencies` gains an optional
  `readProvisioningLog` and an optional `logger`; both facades wire them through the shared
  container, so nothing outside a hand-built instance is affected.
  
  The provisioning-log operation vocabulary gains `remediate`, and the platform appends one such row
  whenever it asks a provider to repair an environment in place. It is a distinct actor, the way
  `teardown-verify` is: the investigation's own second round rebuilds its timeline from that log, so
  an unlogged restart leaves the next round reasoning about an environment it believes nothing has
  touched. Additive on `/api/v1` (spec `info.version` 1.63.0); the clients tolerate unknown enum
  values, and a consumer that maps `operation` through an exhaustive table gains a member to name.

## 0.335.0

### Minor Changes

- dc4a5d9: Import an organisation's Backstage catalog, so triage agents know which services exist and who owns them
  
  The platform knew a great deal about the service being built and, since ADR 0031, about the shared
  capabilities a deployment registered by hand. It knew nothing about the rest of the estate. That
  cost most on the triage path: a bug investigator looking at a cross-service report had the
  repositories it was handed and no record of what else the organisation runs, who owns it, or what
  it exposes, so "which service is this?" was answered from repository names.
  
  Most organisations already record exactly that, in a developer portal. A workspace can now point
  the platform at its Backstage instance and have its components arrive as `workspace`-tier
  foundational services: identity, owner, system, domain and lifecycle composed into the
  description, tags as capabilities, and each API entity's definition stored as one of the service's
  contracts.
  
  **It feeds the EXISTING catalog rather than standing beside it**, which is the decision the rest
  follows from. A parallel mechanism would have meant a second `.cat-context/` directory, a second
  set of trait guidance, a second tiered merge and a second suppression surface, all describing the
  same organisation to the same agents. So an imported service is an ordinary catalog row carrying
  `sourceId: 'service-catalog'`, and the tier merge, the suppression sub-resource, the lazily-read
  contract documents and the SPA's catalog list are untouched.
  
  **Triage agents read it under a new `service-estate` trait, deliberately not the design one.**
  `foundational-catalog` asks its kind to prefer consuming a shared service and to end its reply
  with a machine-read declaration block; both are wrong for an agent whose job is to locate a fault,
  and the second is worse than wrong, because `bug-investigator` and its peers are structured-output
  kinds whose reply IS a JSON object. The estate file states ownership and interface surface and
  asks for nothing back. `bug-investigator` and `on-call` carry it; a deployment's own kind opts in
  through `registerAgentKind({ traits })`. It carries no contract DOCUMENTS: an orientation read
  happens on every triage dispatch, and folding every service's OpenAPI document into one would make
  the prompt scale with the size of the organisation's specs, which is what the catalog/contracts
  split exists to prevent.
  
  **The auth modes are a closed vocabulary of the shapes a self-hosted portal actually runs
  behind**: a static service token, the legacy shared secret (a short-lived HS256 token the platform
  mints per pass), OAuth2 client credentials for an instance behind an IdP or an identity-aware
  proxy, HTTP Basic for a reverse proxy, an explicit header list for a gateway that authenticates on
  its own names, and none at all for an instance reachable only inside a VPN. Free-form headers
  alone would have covered the mechanics and lost every remedy an operator needs when one fails. Two
  details are load-bearing: the legacy secret is base64-DECODED into an HMAC key rather than used as
  UTF-8 (which is what decides whether the token verifies at all, so a secret that is not base64 is
  refused rather than signed with the wrong key), and the header mode takes a LIST because the
  common case needs two: a Cloudflare Access service token is an id plus a secret, and a
  single-pair shape would have sent half a credential.
  
  Reviewers may want to look hardest at three things.
  
  **Widening the URL guard is the ordinary case here, not an exception.** A self-hosted portal
  usually lives on an internal host, so `SERVICE_CATALOG_ALLOW_URL_HOSTS` /
  `SERVICE_CATALOG_ALLOW_HTTP_URLS` exist and are scoped to this integration alone. Redirects are
  followed by hand and re-checked per hop, with the body and `Authorization` dropped on a
  cross-origin one, because the base URL is operator-supplied.
  
  **A partial import must never read as the estate.** An import reports `complete` / `truncated` /
  `empty` coverage plus three skip counts, and stamps `ok` / `partial` / `failed` with a sentence on
  the connection. `empty` is `partial` rather than a healthy import of zero services, because a
  filter that matched nothing is a configuration problem with a remedy. EVERY failure past the
  connection lookup is stamped before it propagates, including one raised before the portal is
  contacted: `lastSyncedAt` is what the autorefresh sweep orders on and it sorts nulls first, so an
  unstamped failure would pin that connection to the head of the stale queue and starve the sweep.
  A failure tombstones nothing: an unreachable portal and an empty one are opposite facts.
  
  **The import YIELDS to a service the workspace already registered by another route**, counting the
  refusal as `skippedConflicts` rather than taking the id over. An upsert there would replace a
  hand-authored row, delete its uploaded contracts and strip any platform capability it was granted,
  and disconnecting would then tombstone the original.
  
  **Two size ratchets moved DOWN, both by splitting.** The Worker's `container.ts` lost its three
  content-library selectors to a new `container-content-library-deps.ts`, the twin of the file the
  Node facade already had, so both facades now hold the same selectors in the same place (874 → 800).
  `orchestration`'s `dependencies.ts` lost the same three libraries' declarations to
  `content-library-dependencies.ts`, which `CoreDependencies` extends (1514 → 1301, under the
  default).
  
  Also in here, because the import needs them: `asyncapi`, `graphql` and `grpc` join the
  contract-format vocabulary, with AsyncAPI indexed (its channels are a parse, not a guess) and the
  other two answering through `operationsAreIndexable` as formats nobody reads. That widened what a
  linked-repository SCAN picks up too, so `detectContractFormat` requires a type-system definition of
  a `.graphql`/`.gql` file and a `service` block of a `.proto` one: the common `.gql` in a repo is a
  client's query text and the common `.proto` is generated message shapes, and neither is an
  interface the service publishes. `ApiContractManifestEntry` gains `sourceSha`, so a sync can decide
  whether a document changed without reading a body. The rendered catalog and estate blocks gained a
  total size cap that states what it dropped, because an imported estate is the first catalog whose
  size is decided by the organisation rather than by this deployment; the catalog's per-service
  heading now reads `id (Name)`, the form the estate block already used.
  
  Four batched repository methods land with it (`upsertMany`, `softDeleteByIds`,
  `replaceForServices`, `deleteForServices`, all on the mothership allow-list): reconciling a
  thousand-service estate one row at a time is two thousand sequential round trips inside one
  request. The `ownerFieldList` scope rule is new beside them, binding every record of a batched
  write rather than the first.
- 4d999cb: Treat OpenRouter as the gateway it is, rather than as one more OpenAI-compatible vendor.
  
  **Its own client.** `openrouter` now resolves through `@openrouter/ai-sdk-provider`
  (`openRouterResolver`) instead of the generic `createOpenAICompatible`; every other
  OpenAI-compatible provider is unchanged. The dispatch is made once, in
  `directOpenAiCompatibleResolver`, which both entry points that build a provider from a leased key
  route through.
  
  **Cost and upstream are now RECORDED rather than derived.** Usage accounting is requested on both
  model paths, so `llm_call_metrics` gains `reported_cost_usd` (the gateway's own USD ledger figure)
  and `upstream_provider` (which vendor actually served the call). Both are nullable and null is
  load-bearing: every other cost on the table is derived from the spend price table, so a 0 would
  report an unpriced call as free. **Break:** the two columns are added to the D1 telemetry store, the
  Postgres `telemetry` schema and local mode's SQLite store; existing rows read NULL, which is the
  correct answer for them.
  
  **`supportsStructuredOutputs` is now set** on the generic OpenAI-compatible client for the cloud
  VENDORS. Without it the SDK silently rewrites a schema-carrying request to `{ type: 'json_object' }`
  and drops the schema. Nothing in this repo passes a schema today, so this closes a trap rather than
  changing behaviour. It is withheld from the upstreams nobody here can vouch for: per-user local
  runners (which never come through this path anyway) and the operator-hosted `bifrost` / `litellm`
  gateways, whose model ids are the operator's own aliases and routinely front an Ollama or vLLM
  model that answers a `json_schema` request with a 400.
  
  **The `/models` catalog reads what it was dropping**: the conditional `overrides` pricing bands
  (folded to their maximum), both cache classes and the 1-hour write fallback, `expiration_date` and
  `canonical_slug`. A published cache rate now reaches the spend table instead of the derived
  multiplier, unless it is zero, which cannot be told apart from a placeholder for a class the
  gateway does not bill separately and would meter every cache hit free. A model's withdrawal date
  is shown in the catalog picker.
  
  **Prompt caching is no longer reported as absent for every gateway model.** `providerCachePolicy`
  takes the model, so an `openrouter:deepseek/…` slug resolves to the policy stated for its vendor
  prefix. Those are stated per prefix rather than borrowed from the direct provider of the same
  name, because the two genuinely differ: OpenRouter's Moonshot route caches automatically while our
  direct `moonshot` does not, and its Alibaba route needs explicit breakpoints while direct Qwen
  does not. Anthropic (and now Qwen) behind a gateway stays `none`, because nothing on that path
  sends `cache_control`. **Break:** the rule moved from `@cat-factory/kernel` to
  `@cat-factory/contracts` (kernel re-exports it unchanged) so the SPA can read the same function
  instead of mirroring it in a Vue constant, which had already drifted.
  
  **Two new env vars, because both routing constraints can empty the upstream pool.**
  `OPENROUTER_DATA_COLLECTION` (default `deny`, stricter than the vendor's own) is whether OpenRouter
  may route to a prompt-retaining upstream; `OPENROUTER_REQUIRE_PARAMETERS` (default `true`) is
  whether it must route only to an upstream advertising every parameter the request carries. A pool
  narrowed to nothing is a 404, not a degraded call, so the proxy recognises that refusal and records
  which constraint could have caused it: the gateway cannot say, since our request is the only place
  both are stated.
  
  **New check `scripts/check-openrouter-pins.mjs`** re-reads the live catalogue against the spend
  table's pinned slugs, comparing all three pinned classes: input, output, and the cache-READ rate a
  row names only where the vendor departs from the derived floor (so nothing else follows it when the
  vendor moves). Its runs found four pins metering below the live rate, one
  (`deepseek/deepseek-v4-pro`) by nearly 3x; all four are repinned here.
  
  **Reported cost and upstream are rendered**, in the observability panel's call list: the upstream
  beside `provider:model`, the gateway's own figure in the expanded row. They stay out of the spend
  rollups, which remain derived end to end, because a rollup mixing a measured figure for one
  provider's rows with an estimate for the rest answers a different question per row.
  
  **The inline instrumented provider now REFUSES to stream** rather than passing an unrecorded call
  through. Nothing inline streams today (the recorder hard-codes `streaming: false` for that reason),
  and a streamed call would have reached no sink at all, which downstream is indistinguishable from a
  step that spent nothing.

## 0.334.0

### Minor Changes

- 4b1c76f: Bound the activity-scaled Reports breakdowns, and give run activity its own repository axis
  
  Two findings from a review of the account Reports surface.
  
  **The two breakdowns that grow with activity were served and rendered whole.**
  `spend.byRun` is one row per pipeline execution that spent anything in the window and
  `spend.byTicket` one per tracker issue a run touched; every other dimension keys on a catalog
  and stays in the tens. The panel read returned all of them and rendered each as a DOM row, so
  a busy account opening a `90d` window paid for the tail twice. The port's "no row cap"
  rationale had gone stale: it enumerated the bounded dimensions and named `ticket` as the one
  exception, having been written before `run` was added, which is strictly worse. The public
  `GET /api/v1/usage/spend` had already capped for its own reasons, so one service was capping
  for one caller and not the other.
  
  `ReportsService.summarize` now caps those two at 100 slices and reports each cap on the
  projection as `capped: [{ dimension, returned, omitted }]`; an empty array means every
  breakdown is complete, and the panel prints the note under the capped card. The cap is applied
  to the aggregated rows rather than pushed into the `GROUP BY` as a SQL `LIMIT`, which is what
  keeps `omitted` an exact count, and the window totals still fold from an uncapped breakdown,
  so what a cap costs the reader is the identity of the tail and never its money. Both callers
  of the port now cap through the one `capSlices` helper; the public `GET /api/v1/usage/spend`
  keeps reporting it as the boolean `truncated` its frozen response schema carries.
  
  **Run activity gained a `repo` dimension.** Spend answered what a repository cost while
  activity could not answer how much work went into it or how much of it failed. The recorded
  reason was that a run is already counted under the service owning its repository, which holds
  only where services map one-to-one onto repositories: several services on one repository is
  the ordinary monorepo shape, and no read publishes that mapping for a caller to fold the
  counts itself. It is one `GROUP BY` over `agent_runs` through the same two primary-key joins
  the `repo` spend dimension uses, so neither can fan the run count out.
  
  Two internal wire changes ride along, per the pre-1.0 rule for internal shapes: the reports
  projection gains `capped` and `activity.byRepo`, and `ReportActivityDimension` gains `repo`.
  The public API is untouched (it publishes no activity axis). In the panel, the repository
  breakdown moves out of the spend-only card row and into the paired spend + activity dimension
  switch beside board, service and task type.

## 0.333.0

### Minor Changes

- 27b22a3: Wait for an ephemeral environment to actually come up, and refuse to test one that has not
  
  A `deployer` step provisioned an environment through an asynchronous provider, which returned in
  1.9 seconds with the environment still building, and the step recorded the task's own frame
  `ready` anyway. Nothing read the provider again for the rest of the run. `tester-api` was
  dispatched a second later with `URL: (pending)` beside an instruction to test that URL; the
  environment came online 5m36s after the create call, while the tester was still running, and the
  run never noticed. The tester did not take the bail-out its prompt offers either: it reconstructed
  the deployment locally, tested that, and returned `greenlight: true` with the environment itself
  recorded as skipped, on a task whose whole brief was to stand that environment up.
  
  Three changes, in the order the run hits them:
  
  - A provider answer that is not `ready` is no longer recorded as `ready`. `provisioning` parks the
    step on a readiness wait; anything else records the frame failed, naming the state.
  - The wait re-reads the provider's own `status()` between driver polls until the environment is
    ready, reaches a state it will never leave, or crosses a 20-minute ceiling. It is a first-class
    park (`awaiting_environment`) on both durable drivers, and it is visible while it happens: the
    step's Environment panel shows the environment spinning up rather than an idle-looking run.
  - A step whose run mode IS the ephemeral environment and that has no reachable URL is refused at
    dispatch instead of being handed a contradictory prompt. Two causes, two codes: an environment
    that exists but is not reachable (`environment_not_ready`) and a run that provisioned none at
    all (`environment_missing`, a pipeline reaching a tester with no `deployer` ahead of it).
  
  `EnvironmentFailureReason` gains those two members; a readiness ceiling that expires reports the
  existing `timeout`.
  
  Two behaviour changes worth knowing about beyond the headline:
  
  - **An involved-service (peer) frame now waits too**, where a peer that was not `ready` used to be
    dropped on the spot as enrichment the run could proceed without. A peer is not only enrichment:
    its URL is fed into the NEXT frame's provision inputs, and frames are provisioned
    provider-before-consumer precisely so a consumer can template its provider's address into its own
    manifest. Dropping a peer that is still building therefore provisions the consumer (usually the
    task's own frame, which goes last) against an address that is silently missing. Under an
    asynchronous provider every peer answers `provisioning` first, so the old fast-drop made that
    ordering guarantee vacuous. The cost is that a peer stuck coming up now holds the run up to the
    readiness ceiling instead of being dropped instantly; it still settles non-terminally.
  - **Both durable drivers now drain parks in a loop rather than a fixed branch sequence.** A poll
    routinely resolves into a _different_ park (a deploy job settling into an environment that is
    still building; a `ci` gate dispatching a `ci-fixer`), and only a loop makes the order of those
    branches irrelevant. The Worker's durable step names are scoped per hop as a result, so a
    Workflows instance in flight across the upgrade re-issues the polls of its current step rather
    than replaying memoised ones.

## 0.332.0

### Minor Changes

- e1f6325: Move the harness job server off `:8080`, so a tester grades the product rather than the platform.
  
  The harness is PID 1 of the job container and shares its network namespace with everything the
  agent starts, and it held 8080: the most common default for a containerised HTTP service. A
  service under test started on its own documented default died with `EADDRINUSE`, and a health
  check aimed at 8080 got a 200 back from the harness, whose body begins `{"status":"ok"}`. Every
  ordinary health assertion passes against that, so a step could report green on a service that
  never ran.
  
  Both images (executor and deploy) now bind `27182`, and the four backend copies of the number
  collapse onto one `HARNESS_JOB_PORT` in `@cat-factory/contracts`, pinned to each harness's own
  literal by a conformity test. The environment inventory the harness states to every agent now
  names the port it holds and says a reply from it is not evidence, which stays true for a
  deployment that overrides `PORT`.
  
  Moving the number is not on its own the fix, because the harness exports the port it holds as
  `PORT` and the agent's own processes inherited it: a service written as `listen(process.env.PORT)`
  would have been aimed straight back at the one address in the namespace it cannot have. `PORT`
  joins `NODE_ENV` on the short list of harness variables stripped from everything spawned into the
  checkout, so the collision is closed rather than relocated.
  
  Two things now hold the port in one place per job. Every facade STATES the port the container must
  bind rather than leaving it to the image: the Kubernetes pod spec already did, and the local
  container adapters and the Cloudflare container class now do too. A deployment pins its own
  mirrored image tag, so without that the published port and the served one were joined only by the
  image happening to agree, and a tag from before this change would answer nothing and surface as a
  container that never became ready (rather than as the version handshake naming the skew, which
  needs a reachable harness to run at all). And the frontend stand-up refuses a serve port equal to
  the port the harness is listening on, read from the live process rather than predicted from the
  shared constant, which is what covers a deployment whose `PORT` the constant does not name.
  
  Breaking for a deployment that pins the harness port itself: a runner pool's pod spec, a
  `NetworkPolicy`, or a `harnessPort` runner-backend setting written against 8080 must move with the
  image tag. **A pool left on `harnessPort: 8080` keeps dispatching, which is the trap rather than
  the relief**: the harness then holds 8080 inside every job container, exactly the collision this
  change removes, and a `frontend` frame is free to be configured to serve there because the shared
  guard now reserves 27182. The stand-up refusal above is what makes that land as a named infra gap
  instead of a green grade against the platform, but the pool setting is still the thing to clear.

### Patch Changes

- 90a915e: Attribute an inline agent step's tokens to the credential that served them, not to the path it
  ran on. A deployment serving inline steps through a subscription harness (the local facade's
  ambient claude/codex CLI, or a container on a leased subscription token) filed every
  non-containerised kind as metered spend with a blank vendor, so companion and research steps
  were counted as money on a plan that costs nothing per token. A resolved model now declares
  its billing, both metering sites forward it, and a subscription row always names a vendor.
  
  The step-level rollup carries the billing kind too (`PipelineStep.usageBilling`), so
  `metrics.costEstimate`, which is a list-price estimate for both billing kinds, renders labelled
  instead of reading as spend.
  
  The declaration travels on the resolved model, so it has to survive the provider decorators
  stacked above it: the AI SDK's `wrapLanguageModel` returns a fresh object that keeps only the
  members it knows about, and the inline concurrency limiter wraps every subscription vendor by
  default. Both decorators now wrap through `wrapModelPreservingMarkers`, which also keeps the
  existing `reportsOwnLlmCalls` marker readable wherever a decorator sits above the model that
  declares it.
  
  A consensus panel reports the billing its models agree on, so a diverted step on one
  subscription credential stops filing as metered too. A panel straddling two credentials keeps
  the metered default, because it did spend real money and one ledger row cannot state both.

## 0.331.0

### Minor Changes

- 7d899c4: Stop publishing an ephemeral-environment URL nothing can serve, and make a containerized tester
  able to reach one that can.
  
  An acceptance pass deployed a healthy pod, published `http://cf-acc-pr8.127.0.0.1.nip.io`, reported
  the environment `ready`, and then spent fourteen minutes in the tester on curl code 000 before
  failing the run at forty-three minutes. Two independent faults, both of which PR #2075 named and
  left open:
  
  - **The Ingress was claimed by nothing.** It declared `ingressClassName: nginx` on a cluster
    running Traefik. The apiserver accepts that, no controller watches it, `status.loadBalancer`
    stays empty, and readiness (which was the Deployments' rollout and nothing else) still said
    `ready`. The Kubernetes provider now grades a template-derived URL against the cluster's own
    `IngressClass` catalog and reports `failed` / `config_incomplete` naming both the requested class
    and the available ones. It fails only on POSITIVE evidence that no controller can claim the
    Ingress; a missing address is `pending`, never a refusal, and a cluster that will not answer the
    cluster-scoped read passes through byte-for-byte as before. `cat-factory k3s` grants the
    `ingressclasses` read so a cluster it provisions can answer.
  - **A loopback URL is unreachable from an agent container**, whose `127.0.0.1` is its own network
    namespace. The local facade now maps the environment's host to the container's host gateway, so
    one URL means the right thing to the operator's browser and to the agent alike. A container that
    predates its environment is replaced, and a bridged job never takes a warm-pool member (a member
    is re-leased across runs, so one run's per-PR entry would leak into the next). It covers every
    environment a job is handed, not just the frame's own: a live peer service's environment for a
    cross-service test and a frontend flow's resolved backend binding fail identically without it.
    The URLs ride the dispatch OPTIONS as a declared, typed list rather than being dug back out of
    the job body, where they sit three levels down under a wire shape the harness owns.
  
    A URL naming this machine that NO bridge can re-point is reported rather than bridged: a hosts
    entry cannot displace the `127.0.0.1 localhost` line an image ships with, and it is never
    consulted for a bare IP literal. A compose environment publishes `http://localhost:<port>`, so
    bridging it bought nothing while costing every such run its warm-pool member and a container
    replacement. Those runs are pooled again, and the log now says the environment is out of the
    agent's reach instead of leaving it to be discovered as a dead cluster.
  
  Also: the acceptance suite refuses a pass up front when the cluster runs no ingress controller or
  publishes no host port into it, reusing `cat-factory k3s`' probe; its scaffold briefs tell agents to
  leave `ingressClassName` unset so the cluster's default class claims the Ingress; and the run driver
  reports step TRANSITIONS instead of only sampling `currentStep`, so a step that starts and finishes
  between two polls is still named. That last one is why this failure was misread: the `deployer`
  finished in one second against a ten-second poll, so the pass jumped from `reviewer` to
  `tester-api` and the step that published the bad URL never appeared in the log at all.
  
  Alongside them, `/api/v1` serves `skipped` on a run's steps (an additive optional field, OpenAPI
  `1.62.0`). A skipped step's `state` is `done` with no output, which is byte-for-byte a step that
  ran and produced nothing, so following a run's chain could not tell the engine deciding a step was
  unnecessary from the step happening and having nothing to say. The acceptance kit's transition
  reducer already knew how to announce the difference and could not observe it.

## 0.330.0

### Minor Changes

- dc12c82: Runner image: install the Docker daemon that was never there, stop handing the agent the harness's
  `NODE_ENV`, and add the three binaries agents reach for first.
  
  The image installed `docker-ce-rootless-extras` (the wrappers that START a rootless daemon) but
  never `docker-ce` (the daemon) or `iproute2` (the `ip` binary rootlesskit builds its network with),
  so no container could ever run `docker compose`. `entrypoint.sh` backgrounded the start in a
  subshell where its exit status was unobservable, so the Tester's local-infra stand-up silently
  became a no-infra run everywhere, and had done since it shipped. Both packages are installed now,
  and the entrypoint waits for the daemon on a bounded window (in the background, so it never delays
  the container's boot) and RECORDS the verdict: `GET /health` reports it, and the compose stand-up
  refuses a confirmed absence with the cause instead of running compose against nothing.
  
  What the entrypoint records describes BOOT, and a warm-pool container outlives its boot, so the
  stand-up re-checks a recorded absence against a live daemon before refusing on it: a sidecar that
  took longer to come up than the bounded wait allows is not latched into refusing local infra for
  the container's whole life. The record still supplies what only the record holds, the cause and the
  daemon's own log tail.
  
  `infraSetup` gains `dockerAvailable` on the wire (harness → `RunnerInfraSetup` →
  `testerInfraSetupSchema`), and the test window says "No Docker daemon in the executor" rather than
  "Dependencies failed to start" for that case: a compose stack that failed to come up and an
  executor with no daemon are opposite fixes. It is three-valued — absent means the container reached
  no verdict (an older image, or the native host transport, which runs the harness with no entrypoint
  to probe) and must never be read as `false`.
  
  `ENV NODE_ENV=production` is no longer baked into the image. npm reads it as `omit=dev`, so an
  agent's `npm install` in its checkout skipped every devDependency; one measured coder run spent six
  of its forty budgeted tool calls discovering and undoing that. The harness process still gets it
  (from `entrypoint.sh`), and the new `agentChildEnv` seam drops it from everything the harness spawns
  into the checkout — which is what makes the fix hold under the native host transport too, where the
  image is not involved at all.
  
  `python3`, `jq` and `ripgrep` join the image for the same reason `procps` is already there: agents
  reach for all three by reflex and each `command not found` costs a call.
  
  `entrypoint.sh` is also added to the executor images' source lists, so a change to how the container
  boots can no longer republish over a live tag without minting a version.

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).

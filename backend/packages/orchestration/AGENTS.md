# `@cat-factory/orchestration`: delivery-workflow engine + domain composition root

**Entry:** `src/index.ts`; `src/container.ts`: `createCore()`, the domain composition root
(the `Core` contract + the always-present spine assembly). Its dependency contract,
`CoreDependencies`, is ~815 lines of pure declaration and lives in its own
`src/container/dependencies.ts`, re-exported from `container.ts` so every import site is
unchanged: add a new dependency field there, not here. The ~30
optional-module factory functions live in `src/container/modules.ts` (the inline iterative-review
ones (requirements / clarity / brainstorm) in `src/container/review-modules.ts`, re-exported from
`modules.ts`), and their optional
wiring flows through the typed `ModuleRegistry` in `src/container/module-registry.ts` (each
optional module is `build(key, factory)`-declared once and emitted via `...modules.assemble()`:
see `docs/internal/refactoring-candidates.md` #6). `Core` = `CoreSpine` (always present) +
`OptionalCoreModules` (registry-assembled). `createCore` itself is kept under its per-function
line budget by four verbatim slice extractions, each registering in the SAME order (which IS
dependency order for the registry) and returning only what the rest of `createCore` consumes:
`container/foundation.ts` (notifications/settings, board/workspace/account/user + account
onboarding), `container/platform-modules.ts` (observability, the provisioning event log, the
preflight → shared-stacks → environments → handler-seeder chain, and the documents → fragment
library → skill library chain), `container/engine-collaborators.ts` (the services the engine needs
BEFORE it is constructed) and `container/engine-dependent-modules.ts` (the modules that drive the
assembled engine). Grow one of these rather than `container.ts` itself.

**Where things live** (`src/modules/*`, one dir per concern):

- `execution/`: **the run engine; start here for anything about how a pipeline step is
  driven.** The two largest files are `ExecutionService.ts` (run lifecycle:
  start/retry/restart/cancel, decisions/approvals, the merge subgraph) +
  `RunDispatcher.ts` (the per-step dispatch + completion spine and its four registries),
  each ratcheted by `scripts/check-file-size.mjs`. Their extracted collaborators sit
  beside them: `dispatcher-registries.ts` (the three built-in dispatch registries (step
  handlers, completion interceptors, post-completion/terminal resolvers) built over the
  `DispatcherRegistryDeps` seam the dispatcher assembles), `RunAdmission` (the
  start/retry/restart `assert*` preflights),
  `review-kinds.ts` (the requirements/clarity/brainstorm `ReviewKind` factories),
  `stepPreamble.ts` (the FIXED four pre-dispatch checks every step clears, in the order money
  is at stake: spend gate, decision park, input gate, estimate gating) + `InputGateController`
  (the **pre-dispatch input gate**: evaluate at step 0 over kernel's pure check, park, and the
  `recheck` / `proceed` resolve both the SPA and `/api/v1` drive; `wouldBlock` is the read-only
  form the public API's admission asks before a run exists),
  `StepDecisionController` (the HUMAN decision surface on a parked run; resolve / approve /
  request-changes / reject / merge / decline-to-merge and the human-review fix request; the
  engine keeps thin delegates because the HTTP + public-API controllers reach it through the
  facade) + `step-park.logic.ts` (`dedicatedParkSurface`: WHICH surface owns a parked step, since
  `step.approval` is the generic parking mechanism a dozen specialised gates ride — shared with
  the public API's decision projection so what it offers and what this refuses cannot drift), `PollRunningController` + `PollCompletionController` (the RUNNING and SETTLED halves
  of the agent-poll branch tree), `OneShotStepController` (the one-shot engine steps `tracker` /
  `bug-intake` / `initiative-committer`),
  `DeployerStepController` (the deployer provision fan-out + env projection; the fourth
  one-shot step, which had its own controller first),
  `DisposerStepController` (the deployer's counterpart: reclaims the environments THIS RUN stood
  up, by the id the deployer recorded on `step.deployEnvs` — never re-resolved from the frame,
  because that read falls back to the block's frame-less manual/`human-test` environment — and is
  best-effort, so a teardown hiccup never fails a shipped run),
  `FollowUpGateController` (the follow-up companion gate + its human-action API),
  `RunMergePolicy` (which merge preset governs a run + settling its merge track record when a
  human merges or declines), `PostMergeBoardController` (the BOARD-shaped follow-up a merged task
  triggers; materialising its assigned module and starting the dependents it was blocking; it
  reads the board rather than execution state and is best-effort, which is what separated it from
  the run state machine), `GateStepController` + `GateHelperDispatcher` (the polling-gate
  state machine and its escalation half) and `extension-contexts.ts` (the shared `GateContext` /
  `JudgeContext` the two extension families are handed; built beside each other so neither can
  drift), `JudgeStepController` + `JudgeService` (the **judge** driver (rubric assessment vs the
  task's threshold, disposed as advance / park / bounce / fail) and its inline LLM assessor),
  `linked-context.ts` (resolving a block's attached docs/issues UNION the refs its description
  names; shared by `AgentContextBuilder` and the inline initiative interviewer, which builds its
  own prompt and would otherwise see a different set of attachments than the analyst and planner
  that follow it),
  plus `RunStateMachine`, `StepGraph`, the companion/review
  controllers, and `*.logic.ts` helpers (`ci.logic`, `release.logic`, `stepGating.logic`, …), and
  `PrVerificationReportController` + `prReport.logic.ts` (the **PR verification report**:
  composed from the settled run's own state and published onto EACH pull request the run opened
  through the `PrVerificationReportPublisher` port; a cross-service run's peer PRs get their own
  SCOPED copy, which withholds the own-service-only sections rather than restating them, so the
  write-avoidance cache is keyed per run AND target while the run's evidence is READ once per
  settlement and layered per PR), with `prReport.environments.ts` holding the **test
  environment lifecycle** proof (environment up → evidence captured from it while live →
  teardown confirmed) because it is the one section composed from a source outside the
  in-memory run: the provisioning event log, which is what dates the bring-up and the teardown.
  `prReport.commands.ts` holds the two CAPTURED-OUTPUT sections (the platform's own pre-PR
  validation run off `step.validation`, and the bugfix reproduction proof off `step.reproduction`),
  which are the report's only sections carrying raw command logs rather than a verdict somebody
  produced: they bound each log from the END (a failure is reported at the tail), record the cut in
  the report's `truncations`, and fence it with `hostMarkdown.outputBlock`, whose fence is sized one
  tick longer than the longest backtick run in the log so a linter quoting a fenced snippet cannot
  spill the rest of the report — including the machine-readable JSON block — into the body as prose.
  Its teardown leg is closed out of band by `ExecutionService.refreshVerificationReport`, wired
  to the teardown service's teardown-recorded hook (which fires on a failed attempt too), since
  the TTL sweep reclaims an environment long after the run's last step settled. The step-selection
  rule both halves share lives under both in `prReport.steps.ts`, beside `absentNote`, the ONE
  renderer for an absent section's note (through `hostMarkdown`, since a note now names a pull
  request and `owner/repo#12` is a reference the host resolves). Every untrusted value it
  interpolates crosses kernel's
  shared `hostMarkdown` boundary (`shared/host-markdown.logic.ts`: auto-link triggers, table
  cells, code fences), which lives there rather than here because the tracker-issue writebacks
  in `@cat-factory/integrations` render through the SAME escapes; the composer scrubs free text
  with `redactSecrets` before either the prose or the JSON block sees it. `ExecutionServiceDependencies.ts` holds the engine's
  injected-collaborator contract, re-exported from `ExecutionService.ts`. `runStart.ts` holds the two
  funnels every path that brings a run to life passes through (the atomic live-run CLAIM and the
  HAND-OFF to the durable runner, the SPA and the outbound lifecycle sink) because
  `start`/`retry`/`restartFrom` differ only in the block patch they write between them, so the order
  across them is owned in one place rather than three. The run/step lifecycle
  reference is `docs/execution-state-machine.md`.
- `merge/`: the merge policy + its evidence: `RiskPolicyService` (the per-workspace
  merge-threshold preset library, including the per-class `classRules`), `MergeTrackRecordService`
  (deterministic change classification + the persisted record of every merge decision, the
  reviewer-effort tag, and the per-class SQL rollups) and `externalMergeObserver` (attributing a
  PR merged directly on the provider). See CLAUDE.md → "Merge track record".
- `observability/`: the read side of telemetry: `LlmObservabilityService` (per-call metrics),
  `ToolCallObservabilityService` (the tool-call TRAJECTORY: what an agent DID, one row per
  invocation; it honours the `bodies` state it is handed and never upgrades it, because the gate
  is applied at the drain that also feeds the trace sinks),
  `PlatformObservabilityService` (deployment health) and `ReportsService` + `reports.logic.ts`
  (**Reports**; cross-cutting usage analytics: spend by model/agent kind and spend + run activity
  by workspace/service/task type, over the `ReportsRepository` port; see CLAUDE.md → "Reports" and
  `backend/docs/reports.md`). `ReportsService` lives in its own `reports/` dir beside them.
  `GateOutcomeRecorder` is the one WRITER here: the gate machine hands it each polling gate that
  reaches a terminal verdict, and it projects the flat row the dashboard's attempt statistics
  aggregate. Its row id is DERIVED from the run (`<runId>:<stepIndex>:<outcome>`), not minted,
  because the durable drivers replay. See CLAUDE.md → "Telemetry & agent-context observability".
- `debug/`: the read service behind the PUBLIC remote **run debugging** surface (`/api/v1/debug/*`):
  `RunDebugService` issues the bounded reads (a keyset-paged run index plus the four telemetry
  sinks, each independently optional; the body search and slice windows ride to the stores in
  SQL), `debug.logic.ts` holds the pure projections; the `debugText` slice-and-say-so shape
  (offset-windowed, match-offset-carrying), the step/call/snapshot projections, the rollup fold,
  and `deriveSignals` (the precomputed diagnostic hints the overview leads with), and
  `promptMessages.ts` owns the lenient `?view=messages` parse of a stored prompt delta into
  independently-budgeted per-message rows. Every bound lives in the contract or the SQL, never
  here. See `backend/docs/debug-api.md`.
- `pipelines/pipelineAdoption.ts`: reconciling a workspace's stored pipeline rows with the CODE
  catalog. `adoptForRun` resolves a run's pipeline and MATERIALISES a catalog built-in the board was
  never seeded with (a reusable operation pins its pipeline by id, so an older board would otherwise
  refuse to start a task it created); `resolveDefinition` is the read-only twin for a question about
  a prospective run (every gate in front of a start, so a bare `pipelineRepository.get` there is the
  smell); `adoptableCatalog` is the bulk form for a caller already holding the workspace's whole
  list. Only `builtin` entries adopt, the write is the idempotent `insertIfAbsent`, and
  `PipelineService.reseed` shares its row builder. See
  `backend/docs/pipeline-catalog-lifecycle.md`.
- `board/taskTypeCreationDefaults.ts`: everything a new task's TYPE implies for the row
  `BoardService.addTask` writes, together because all three are one `TaskTypeRegistry` lookup read
  three times: the best-practice fragment union (service picks ⊕ per-type defaults ⊕ a registered
  REUSABLE OPERATION's standing context), the default-pipeline pin, and the check of the collected
  `custom` bag against the descriptor. Three cases pass the check through on purpose (a built-in
  type, an unregistered namespaced one, a `formPanel` descriptor). See
  `backend/docs/reusable-operations.md`.
- `bootstrap/`, `pipelines/`, `board/`, `boardScan/`, `requirements/`,
  `notifications/`, `releaseHealth/`, `review/`, `estimation/`, `kaizen/`, `sandbox/`,
  `recurring/`, `settings/`, …: the other module services. In `review/`, EVERY write to a review
  goes through `IterativeReviewService.mutateReview` (load → apply → rev-guarded
  `compareAndSwap`, reloading and re-applying on a lost race) and a fresh run publishes with the
  atomic `replaceForBlock`: a blind `upsert` drops a concurrent editor's answer. `review/` also
  owns the two things every inline reviewer shares: `product-context.ts` (which system the work
  belongs to, STATING an unresolved one) and `IterativeReviewService.systemPromptFor`, which composes
  each kind's `{ role, directives }` pair so a per-workspace prompt override replaces the role only.
  See CLAUDE.md → "Requirements review".
- `validation/`: request validation, plus `validateRegistrations.ts`, the BOOT check over a
  deployment's registered extensions (kinds, gates, pipelines, task types, generators). Its
  severities are the design: an unresolvable pipeline id is an `error` because the created task
  would silently fall back to the positional default, while a task type's unresolvable
  `defaultFragmentIds` is a `warn` naming both causes, since an account/workspace-tier fragment
  merges per workspace at run time and boot structurally cannot see one.

Two top-level helpers sit beside `modules/` because every INLINE LLM caller shares them, and both
are about resolving ONE thing consistently rather than about any one feature:
`src/inlineScope.ts` (the `ModelScope` for a call on a block, folding in its active run so a leased
per-run credential can be used) and `src/inlineBlockModel.ts` (`resolveInlineBlockModelRef`: WHICH
model that call runs, with the same block-pin → preset default → routing-default precedence the
dispatch path uses, the preset's route ORDER, and the container-only-subscription degrade). It
replaced eight byte-identical private `modelFor` methods; wire it through
`container/inline-model-deps.ts`, which hands over the model and the route order as ONE
`resolvePresetRouting` dependency — they are two columns of one preset row, so wiring them apart
both invited a site to take the model and miss the order (silent: the run works, on the wrong
provider) and read that row twice per call.

**See also:** `CLAUDE.md` → "Execution flow", "Merge lifecycle flow", "Merge track record",
"Requirements review flow", "Gates vs agents" (the four step buckets, judges included); `docs/execution-state-machine.md`; `docs/internal/modularisation.md` +
`docs/internal/refactoring-candidates.md` for the god-file backlog.

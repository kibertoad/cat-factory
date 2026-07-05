# Initiative: bug-triage pipeline (recurring)

## Goal & rationale

Teams accumulate bug backlogs faster than they burn them down. This initiative adds a
**recurring-only pipeline** (`pl_bug_triage`) that works the backlog autonomously: each
scheduled fire pulls ONE issue matching configured predicates (title fragment / label /
issue type, default `bug`) from the workspace's issue tracker board, marks it in-progress
with a "taken by cat-factory" comment, investigates across every involved service's repo,
asks a human for clarification when the report is unclear (parking the run, echoing the
questions onto the tracker issue), writes a failing reproduction test (allowed to concede
without failing the run), fixes the bug, and drives the fix through the standard
review → ephemeral-env test → conflicts → CI → merge tail. On merge the existing tracker
writeback closes the issue.

Full design (the source of truth — do not re-derive):
[`backend/docs/bug-triage-pipeline.md`](../../backend/docs/bug-triage-pipeline.md).

Multi-repo investigation/fixing is **not designed here**: this initiative _executes_
Phases 3–4 of [`backend/docs/service-connections.md`](../../backend/docs/service-connections.md)
(tracked in [`service-connections.md`](./service-connections.md) — keep BOTH trackers'
rows in sync when those phases land).

**Update (2026-07-03):** service-connections Phase 3 (= Phase B below) has landed in
[PR #752](https://github.com/kibertoad/cat-factory/pull/752) — `resolveRepoTargets`,
`peerRepos` sibling checkouts, per-repo PR fan-out, `peerPullRequests`, the multi-repo
prompt section, and both-runtime conformance are all implemented there. The PR is **open
and unmerged** (`mergeable_state: dirty` — conflicts with `main`), so Phase B stays
`in-progress` below until it merges; Phases E–H (which build on `peerRepos`/multi-repo
checkouts, notably Phase F's investigator) are blocked on that merge, not just on the
code existing. See the Phase B row notes for details.

**Update (2026-07-04):** Phases C and D are implemented, both stacked on the #752 branch
(Phase C via [PR #761](https://github.com/kibertoad/cat-factory/pull/761), Phase D via
[PR #766](https://github.com/kibertoad/cat-factory/pull/766)) — so the whole stack lands when #752's conflict
with `main` is resolved and the chain merges. Next up: Phase E (the `bug-intake` step +
schedule validation + SPA intake section), which consumes Phase D's ports directly and,
unlike F–H, does not need the multi-repo checkouts.

## Target pattern

Reference implementations to copy, per piece:

- **Recurring pipeline + non-LLM step**: `pl_tech_debt` (`kernel/src/domain/seed.ts`) and
  the `tracker` filing step (`RunDispatcher.runTracker`, `step-handler-registry.ts`) —
  `bug-intake` is its inbound dual.
- **Registered structured container kinds**: the `security-auditor` worked example
  (`backend/internal/example-custom-agent/src/index.ts`) — `container-explore` +
  `structuredOutput` + post-completion resolver + `generic-structured` result view.
- **Clarification park loop**: `clarity-review` (`IterativeReviewService`,
  `ReviewGateController.ts`) with the requirements-review auto-pass pattern.
- **Vendor tracker plumbing**: the `tasks` module providers
  (`integrations/src/modules/tasks/{JiraProvider,GitHubIssuesProvider,LinearTaskProvider}.ts`)
  for search/import, and `IssueWritebackService` for comment/transition.

## Phase checklist

Each phase ≈ one PR. Update the status column (+ PR link) at the end of every PR.

### Phase 0 — design doc + tracker

| Item                                                | Status |
| --------------------------------------------------- | ------ |
| `backend/docs/bug-triage-pipeline.md` (full design) | done   |
| This tracker                                        | done   |

### Phase A — pipeline `availability` attribute (design §2)

| Item                                                                                        | Status |
| ------------------------------------------------------------------------------------------- | ------ |
| Contracts: `availability?: 'one-off'\|'recurring'\|'both'` on `pipelineSchema`              | done   |
| `ExecutionService.start` `origin` option + `assertRunnable` enforcement                     | done   |
| `RecurringPipelineService.create/update` reject `'one-off'`-only pipelines                  | done   |
| `validatePipelineShape`: field validation + `bug-intake` requires `recurring`               | done   |
| SPA pickers: `AddTaskModal.vue` / `RecurringPipelineModal.vue` filters + i18n (all locales) | done   |
| Persistence: `pipelines.availability` column on BOTH runtimes (D1 0037 ⇄ Drizzle) + mapper  | done   |

Implemented on branch `claude/bug-triage-phase-2-5n1wu5`. Notes for later phases:

- **`availability` is a persisted column, not a JSON-blob field.** Pipelines are stored
  column-per-field, so the new field needed a `pipelines.availability` column on BOTH runtimes —
  D1 migration `0037_pipeline_availability.sql` ⇄ Drizzle `schema.ts` + generated migration —
  written/read by the shared `rowToPipeline` mapper (`@cat-factory/server`) and both repos. The
  cross-runtime round-trip (create/update/clone) is pinned by a conformance assertion so a facade
  can't silently drop it again. (An earlier revision of this phase set the field on the domain
  entity only, so it was dropped on save and the whole gate was inert after a DB round-trip.)

- The launch gate is a single pure function, `assertPipelineLaunchable(agentKinds, availability,
origin?)` in `orchestration/modules/pipelines/pipelineShape.ts` — NOT folded into the shared
  `validatePipelineShape`/`assertRunnable` path. That path is re-run on retry/restart over stored
  steps (which carry no `availability` and no `origin`), so putting the `bug-intake`-requires-
  `recurring` check there would falsely fail a legitimate recurring retry. Instead the gate is
  called at the LAUNCH boundaries only: `PipelineService.create/update/clone` (save; no origin),
  `ExecutionService.start` (with the new `origin`), and — for the schedule-attach dual —
  `RecurringPipelineService.create/update` via `assertSchedulable`, which now DELEGATES to the same
  `assertPipelineLaunchable(..., 'recurring', ...)` gate so there is one rule and one error type
  (`ValidationError`) across both boundaries.
- The `bug-intake`-requires-`recurring` check is evaluated over the ENABLED subset (an `enabled?:
boolean[]` arg), matching every other check in `pipelineShape.ts` — a disabled `bug-intake` step
  imposes no requirement.
- Editing a pipeline to `'one-off'` while a schedule still references it is rejected up-front
  (`ConflictError`, via an optional `pipelineScheduleRepository` on `PipelineService`) instead of
  letting every future fire silently fail the origin gate.
- `availability` is a first-class editable/clonable pipeline field: `create`/`update` accept it and
  `clone` preserves it (so cloning the future recurring-only `pl_bug_triage` stays recurring-only).
- `bug-intake` is referenced as a bare string literal (`BUG_INTAKE_AGENT_KIND` in `pipelineShape.ts`)
  — the kind itself is registered in Phase E; the structural guard only needs the identifier.
- SPA filters added `pipelineAllowedForManualStart` / `pipelineAllowedForSchedule` to
  `utils/pipeline.ts` and applied them to ALL manual-start surfaces (add-task modal, board +
  inspector Run menus, task run-settings default) and the recurring modal respectively. No new
  user-facing strings, so no locale-catalog changes were needed this phase.

### Phase B — multi-repo coding (= service-connections Phase 3; update that tracker too)

| Item                                                                                                     | Status                |
| -------------------------------------------------------------------------------------------------------- | --------------------- |
| `resolveRepoTargets` (plural) beside the singular resolver; dedupe by repo; monorepo `serviceDirectory`s | in-progress (PR #752) |
| `AgentJob.peerRepos` + sibling-checkout workspace layout in the harness (image bump)                     | in-progress (PR #752) |
| Push/PR fan-out: same `cat-factory/<blockId>` branch per repo, PR only for dirty repos                   | in-progress (PR #752) |
| `AgentRunResult.peerPullRequests` + `block.peerPullRequests` + `allPullRequests(block)` helper           | in-progress (PR #752) |
| Multi-repo prompt section (peer roles from connection descriptions) + `AGENTS.md` note                   | in-progress (PR #752) |
| Conformance: two-repo coding run records both PRs on both runtimes                                       | in-progress (PR #752) |

All six items are implemented in [PR #752](https://github.com/kibertoad/cat-factory/pull/752)
(`resolveRepoTargets` in `backend/packages/server/src/agents/resolveRepoTarget.ts`,
`renderMultiRepoWorkspaceSection` in `jobBody.ts` for the prompt section,
`MULTI_REPO_GUIDANCE` in the harness `pi.ts` for the "AGENTS.md note", `peerPullRequests`
mirrored D1 ⇄ Drizzle via `0037_peer_pull_requests.sql`). Flip these to `done` once the PR
merges — don't mark done off code sitting on an open branch. Two things to recheck at
merge time: the harness image was actually bumped to **`1.34.5`**, not the `1.34.4` the PR
description states — verify the real pin in `deploy/backend/package.json` /
`wrangler.toml` / `runtimes/local/src/harnessImage.ts` rather than trusting the
description text; and the PR's own conformance case only asserts the _recording_ path
(`peerPullRequests` round-trips through the fake executor), not a real harness dispatch
through `runMultiRepoCoding` — that path is covered only by
`executor-harness/test/agent.test.ts` + `resolveRepoTarget.spec.ts`, not conformance.

### Phase C — multi-PR gates + merger (= service-connections Phase 4; update that tracker too)

Implemented in **PR #761** (branched off #752 for the multi-repo checkouts, targets #752). Kept
to the "Phase B only for harness edits" convention — **zero harness changes / no image bump**: the
ci-fixer fans out by reusing the existing `runMultiRepoCoding` sibling-checkout path via a widened
`peerRepos` job body (the `coder`-only multi-repo dispatch gate now also fires for `ci-fixer`).

| Item                                                                                                   | Status                                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| CI gate aggregates across PRs (`step.gate.headShas` map); fixer runs in the sibling-checkout container | done                                       |
| Conflicts gate per PR; single-repo conflict-resolver dispatched at the first conflicted repo           | done (detection + `conflictTarget`; see †) |
| Merger: combined-diff assessment + all-green-then-merge-all in provider-first order                    | done (merge-all; combined-diff, see ‡)     |
| Mid-sequence merge failure → block `blocked` + notification enumerating merged vs unmerged             | done                                       |
| Conformance: multi-PR gate + merge-all behaviour on both runtimes                                      | done (CI aggregate cross-runtime; §)       |

Notes carried forward (mirrored in the service-connections tracker's Phase 4 rows):

- **† Conflict-resolver peer targeting** — the conflicts gate detects conflicts across every PR and
  stashes the first conflicted repo on `step.gate.conflictTarget`; dispatching the resolver AT a
  peer repo is a follow-up. A peer-only conflict now fast-fails to the manual-resolution give-up
  (the gate returns `escalatable: false` so the engine doesn't burn the attempt budget on the
  own-repo resolver that can't reach it) rather than looping the wrong resolver. Relevant to
  Phase F/G, which reuse the gate helpers.
- **‡ Merger combined-diff** — the engine merges ALL PRs in provider-before-consumer order, but the
  `merger` agent still scores the own-repo diff only (scoring the combined sibling-workspace diff
  needs a harness bump — deferred to keep this phase harness-free).
- **§** — multi-repo CI aggregation runs on both runtimes in conformance; merge-all ordering +
  provider fan-out are unit-tested (`mergeOrder.logic.test.ts`, `multiRepoGateProviders.spec.ts`).

### Phase D — issue-intake foundations (design §3, ports + persistence)

Implemented in [PR #766](https://github.com/kibertoad/cat-factory/pull/766) (branch
`claude/bug-triage-initiative-en124b`, stacked on the #752 branch and targeting it, like Phase C's #761).

| Item                                                                                                        | Status |
| ----------------------------------------------------------------------------------------------------------- | ------ |
| `TaskSourceProvider.searchIssues` + `IssueIntakeQuery`; Jira JQL / GitHub qualifiers / Linear filter impls  | done   |
| `PipelineSchedule.issueIntake` config: contracts + `pipeline_schedules` column, D1 ⇄ Drizzle migrations     | done   |
| `IssueWritebackProvider.onIssuePickedUp` (comment + in-progress transition, 3 vendors, best-effort)         | done   |
| Jira `pickTransitionByCategory` / Linear `pickStartedStateId` / GitHub `inProgressLabel` logic + unit tests | done   |
| `TaskLinkService.replaceForBlock` (unlink previous fire's issue, link the new one)                          | done   |

Notes for Phase E (which consumes all of this):

- **`searchIssues(credentials, query, workspaceId)`** — the port takes `workspaceId` as a third
  param (beyond the design's two-arg sketch) for the same reason `search` does: the GitHub
  provider authenticates out-of-band from the workspace's App installation and would otherwise
  leak across tenants. Jira/Linear ignore it.
- **Exclusion pushdown varies by vendor**: Jira gets `issuekey NOT IN (…)` in the JQL (ids
  validated against the key shape — a malformed/foreign id is dropped, never embedded); GitHub
  and Linear can't express it (no issue-number qualifier / no identifier filter), so both
  overscan by the exclusion count (bounded at the vendors' 100/page) and filter the response.
  Phase E's intake step should keep the exclusion list small (it already is: only issues linked
  to blocks).
- **GitHub oldest-first** rides the search API's `sort=created&order=asc` params (a new optional
  `order?: 'created-asc'` on `GitHubClient.searchIssues`) — the in-query `sort:` syntax is a
  web-UI affordance the REST API ignores. **Linear oldest-first** uses the
  `issues(sort: [{ createdAt: { order: Ascending } }])` argument + a deterministic client-side
  re-sort of the page (nodes carry `createdAt`).
- **`issueIntake` PATCH is tri-state** (`updateScheduleSchema`): omitted = unchanged, `null` =
  clear, object = replace. `RecurringPipelineService.create/update` persist it verbatim — the
  "required + source connected when the pipeline has `bug-intake`" validation is Phase E's row,
  NOT done here.
- **`onIssuePickedUp(workspaceId, blockId, info)`** takes `info.inProgressLabel` (threaded from
  the schedule's `issueIntake.inProgressLabel`; the service defaults it to
  `DEFAULT_IN_PROGRESS_LABEL = 'in-progress'`). It is deliberately NOT gated on the workspace
  writeback toggles — claiming the issue where it was filed is the intake step's semantics.
  `GitHubClient.applyIssueLabel` is an optional client capability (like `listSubIssues`):
  ensure-create the label (tolerating 422 already-exists) then add it to the issue.
- **`TaskRepository.unlinkAllFromBlock`** is a single `UPDATE … WHERE linked_block_id = ?` on
  both runtimes (never a loop of point-writes); it's classified `pending` in the Node
  mothership allow-list spec (fires on the mothership-owned recurring run path, not the SPA).
- Conformance pins the `issueIntake` column round-trip (create → list → replace → unrelated
  patch → clear) on all three facades (`defineMiscConformance` → "recurring pipelines").

### Phase E — `bug-intake` step (design §3, engine + SPA)

Implemented in [PR #770](https://github.com/kibertoad/cat-factory/pull/770) (branch
`claude/bug-triage-phase-2-hyi9pg`, branched off the #752 branch for the Phase D foundations it
consumes, and targeting it, like Phase C's #761 / Phase D's #766). Zero harness changes / no
image bump — the step is backend TypeScript over the Phase D ports.

| Item                                                                                          | Status |
| --------------------------------------------------------------------------------------------- | ------ |
| Step handler: predicate search + batched projection dedupe + oldest-first pick                | done   |
| Pickup: import → replace-link → rewrite block title/description → `onIssuePickedUp`           | done   |
| No-match: skip all remaining steps, run completes successfully, no notification               | done   |
| Schedule validation: `issueIntake` required + source connected when pipeline has `bug-intake` | done   |
| SPA: intake config section in `RecurringPipelineModal.vue` + i18n (all locales)               | done   |
| Conformance: intake pickup + no-match no-op on both runtimes (fake task source)               | done   |

Notes for Phase F/G/H (which build on this step):

- **`BugIntakeService`** (`@cat-factory/integrations`) owns the read-and-claim half (resolve the
  schedule's `issueIntake` by block → `searchIssues` → dedupe against the one batched
  `listByWorkspace` read → import + `replaceForBlock`), returning a pickup or a `null` outcome.
  The engine (`RunDispatcher.runBugIntake`) owns the block-reseed + best-effort `onIssuePickedUp`
  writeback + the completion. It is wired into the engine ONLY when task sources are configured
  (a `TasksModule.bugIntakeService`, threaded through `ExecutionService` like `issueWriteback`).
- **The no-match / no-source path completes the run** via `RunDispatcher.completeRunSkippingRemaining`
  — mark this step's output, mark every remaining step `skipped`, finalize the block `done`. It
  reuses `skipGatedStep`'s terminal machinery; there is deliberately NO new gate/notification.
- **`BUG_INTAKE_AGENT_KIND`** is now exported from `pipelineShape.ts` (with a
  `pipelineHasEnabledBugIntake` helper) as the single source of truth shared by the launch
  constraint, the schedule intake-config validation, and the engine handler.
- **Intake dedupe uses `TaskRepository.listByWorkspace`** filtered to `linkedBlockId && source`
  — one batched projection read, not a per-candidate lookup. The reused block's own previous-fire
  link is in the exclusion set (the search runs BEFORE `replaceForBlock` drops it), so a still-open
  prior bug isn't immediately re-picked.
- **Validation home**: the `issueIntake`-required + connected-source check lives in
  `RecurringPipelineService` (create/update), NOT `assertPipelineLaunchable` (which has no access
  to the schedule config or the workspace's connections). It's skipped for the connected-source
  half when no task-connection service is wired; the presence check always runs.

### Phase F — investigation + clarification (design §4–5)

Implemented on branch `claude/bug-triaging-initiative-tif4vb`, stacked on the #752 branch (for
the multi-repo checkouts it extends) and targeting it, like Phases C/D/E. **Harness change +
image bump** (`1.34.5` → `1.34.6`): the read-only multi-repo explore path is a genuine new
harness capability (the explore mode dropped `peerRepos` — it only ever cloned one repo), so
unlike Phases C–E this phase is NOT harness-free. Pins synced via `pnpm sync:image-tags`.

| Item                                                                                                     | Status |
| -------------------------------------------------------------------------------------------------------- | ------ |
| `bug-investigator` → structured `container-explore` kind (same id) + valibot schema + peerRepos checkout | done   |
| Post-completion resolver: prose digest → `step.output`, structured → `step.custom`                       | done   |
| `clarity-review` seeding from investigator `questions` + auto-pass on `clarity === 'clear'`              | done   |
| `IssueWritebackProvider.postQuestions` tracker comment on park (best-effort)                             | done   |
| Conformance: clear → no park; needs_clarification → park + resume on answer                              | done   |

Notes for Phase G/H (which build on this):

- **`bug-investigator` is a registered kind now**, not a ROLES entry — it self-registers from
  `@cat-factory/agents` (`agents/kinds/bug-investigator.ts`), exporting the lenient
  `bugInvestigation` valibot schema (`clarity` / `summary` / `rootCauseHypotheses` /
  `affectedRepos` / `suggestedReproductions` / `questions`). Its read-only guardrail +
  final-answer-in-reply directives auto-append (the `applySurfaceDirectives` seam), so the
  registered `systemPrompt` is just the core role. Phase G's `repro-test` copies this shape.
- **The digest resolver is a BUILT-IN inline resolver** in `RunDispatcher.buildStepResolverRegistry`
  (`phase: 'post-completion'`, `renderInvestigationDigest`), NOT a `registerStepResolver` call —
  it is a platform kind, so it lives with the other built-in resolvers (merger / blueprints /
  task-estimator), not the public seam. The digest is how the investigation reaches downstream
  container steps: `priorOutputs` carries only `step.output`, so the structured `step.custom`
  alone would be invisible to the estimator / repro-test / coder.
- **The clarity seed is model-independent** — `ClarityReviewService.seedReview` builds the review
  from the investigator's structured triage with `model: null` and no LLM call, sharing the base
  `persistInitialReview` dispose/notify tail. So the clarity gate's `enabled()` is now
  **store-based** (`!!clarityReviewService`), not model-based: it activates whenever the store is
  wired, and the LLM review/incorporate/re-review paths degrade gracefully when no model is wired
  (no investigation + no model ⇒ the gate auto-passes, the old pass-through). This is why the
  conformance park/resume test works with NO reviewer model.
- **The multi-repo fan-out gate** (`MULTI_REPO_FANOUT_KINDS` in `ContainerAgentExecutor`) now
  includes `bug-investigator`. Phase G's `repro-test` (a `container-coding` kind) must be added
  too when a bug spans repos — but it rides the EXISTING coding `runMultiRepoCoding` path (opens
  PRs), NOT the new read-only `runMultiRepoExplore` one.
- **The read-only harness path** (`runMultiRepoExplore` in `executor-harness/src/agent.ts`) is
  deliberately simpler than `runMultiRepoCoding`: clone siblings, run once at root, parse the
  result — no work branches, no push, no PR. The explore result-parsing is now shared with the
  single-repo path via `finalizeExploreResult`.

### Phase G — `repro-test` agent (design §7–8)

Implemented in [PR #797](https://github.com/kibertoad/cat-factory/pull/797) (branch
`claude/bug-triage-phase-g-repro-test`, off `main` — the #752 stack has since merged).
**Harness change + image bump** (`1.34.8` → `1.34.9`): a `container-coding` kind whose deliverable is BOTH a pushed commit AND a
structured JSON outcome is a new harness capability (coding mode never parsed structured output —
only explore mode did), so like Phase F this phase is NOT harness-free. Pins synced via
`pnpm sync:image-tags`. Also fans out multi-repo via the registry flag (`fanOutMultiRepo: true`),
so no edit to the executor's built-in fan-out allow-list was needed.

| Item                                                                                       | Status |
| ------------------------------------------------------------------------------------------ | ------ |
| `repro-test` registered kind (`container-coding`, work branch) + structured outcome schema | done   |
| Concede resolver: `not_reproducible` recorded, run advances (never fails)                  | done   |
| `BUG_FIX_GUIDANCE` coder prompt fragment (applied when a prior `repro-test` output exists) | done   |
| Conformance: reproduced and conceded paths both reach the coder on both runtimes           | done   |

Notes for Phase H (which seeds `pl_bug_triage` using this kind):

- **`repro-test` does NOT open the PR** — it SEEDS the shared work branch (`cat-factory/<blockId>`)
  by committing the failing test(s) and pushing, then the `coder` RESUMES that branch, adds the fix
  and opens the ONE PR (containing both). Expressed declaratively on the kind's `AgentStepSpec`:
  two new `container-coding`-only fields, `opensPr: false` (seed only — a later step opens the PR)
  and `noChangesTolerated: true` (a concede commits nothing, which must not fail the run). The
  default coder/ci-fixer behaviour is unchanged (`opensPr` defaults true for a work-branch coder;
  an in-place PR-branch fixer never opens a PR either way).
- **Structured output on the coding surface (harness):** `runCodingMode` now parses the agent's
  final reply into `custom` when `output.kind === 'structured'`, BEST-EFFORT — the run's real
  deliverable is its pushed commits, so an unparseable outcome degrades to no `custom` (the engine
  resolver then leaves the raw reply) rather than failing the run. Only an infra/eviction failure
  fails a `repro-test` step, like any container kind. `resolveReplyCustom` is shared with the
  explore path (which still treats an unparseable reply as a hard failure — the report IS the whole
  deliverable there).
- **The concede resolver is a BUILT-IN post-completion resolver** in
  `RunDispatcher.buildStepResolverRegistry` (`renderReproDigest`), mirroring the `bug-investigator`
  digest resolver — it folds `{ outcome, testPaths, notes }` into a prose `step.output` so the coder
  reads the reproduction result via `priorOutputs` (which carries only `step.output`), keeping the
  structured object on `step.custom` for the `generic-structured` view.
- **`BUG_FIX_GUIDANCE`** is folded into the CODER's system prompt (in the server's job-body builder,
  exactly like `FOLLOW_UP_GUIDANCE`) via the pure `bugFixGuidanceFor(context)` helper — gated on the
  build-phase coder specifically AND a prior `repro-test` output existing, so it is a no-op for every
  other kind / run.
- **Runtime-neutral `@types/node` gap fixed along the way:** `@cat-factory/server` uses
  `AsyncLocalStorage` (`node:async_hooks`) in `src` — safe on both runtimes under `nodejs_compat`
  — but declared no `@types/node`, so it couldn't typecheck in a strict pnpm layout. Rather than
  pull the whole Node type surface into the runtime-neutral package (which would let `node:fs` /
  `process` typecheck in `src` and break on workerd), `src` now runs with `"types": []` + a minimal
  ambient shim (`src/node-async-hooks.d.ts`) typing only `AsyncLocalStorage`, and the node-using
  TESTS get `@types/node` via a separate `tsconfig.test.json`.

### Phase H — the pipeline itself + end-to-end (design §1, §6, §9–10)

Implemented on branch `claude/bug-triage-phase-h` (off `main`; the #752 stack has since merged).
Zero harness changes / no image bump — every kind it wires already ships. This is the FINAL phase:
the initiative is complete once it merges.

| Item                                                                                                    | Status |
| ------------------------------------------------------------------------------------------------------- | ------ |
| `pl_bug_triage` seed (`availability: 'recurring'`) + `BUG_TRIAGE_PIPELINE_ID` + `'bug-triage'` template | done   |
| `task-estimator` placement + gating validation over the new shape (`pipelineShape.ts`)                  | done   |
| End-to-end conformance: schedule fire → intake → investigate → clarity → repro → fix → merge (fakes)    | done   |
| e2e spec (live pushed UI updates for the recurring run; `data-testid`s as needed)                       | done   |
| Docs: glossary entries (`bug-intake`, `repro-test`), CLAUDE.md flow note if warranted                   | done   |

Notes:

- **The seed is the exact design §1 shape** (`bug-intake → bug-investigator → clarity-review →
task-estimator → repro-test → coder → reviewer → tester-api → conflicts → ci → merger`), with
  only `clarity-review` a human gate (`gates[2]`), mirroring `pl_bugfix`. It is `availability:
'recurring'`, so `assertPipelineLaunchable` refuses a one-off manual start and the SPA hides it
  from the add-task picker (`pipelineAllowedForManualStart`) while surfacing it in the recurring
  modal (`pipelineAllowedForSchedule`). A dedicated `pipelineShape.test.ts` case pins the shape +
  launch constraint + estimator-first placement; the pre-existing "every seed pipeline is valid"
  loop already covers `validatePipelineShape`.
- **The end-to-end conformance test drives the SEEDED `BUG_TRIAGE_PIPELINE_ID`** (not a hand-built
  pipeline) through a schedule with a fake Jira backlog + a single lenient superset `customResult`
  (each structured kind — investigator, repro-test — reads only its own fields), asserting the run
  reaches an auto-merge `done` with intake pickup, a `clear` auto-pass, a `reproduced` outcome, and
  the coder/reviewer/merger all finishing. Runs on all three facades.
- **The e2e spec is the recurring round-trip**, the one assembled-product surface no other spec
  covers: creating a schedule pushes its reused block live (see the `block-added` fix below) and
  run-now drives THAT block to terminal over the WebSocket. Deliberately generic (a simple
  `['architect','coder']` pipeline), because the e2e backend wires no fake task source and the
  `FakeProfile` has no `customResult`/intake knob — the bug-triage step mechanics are asserted in
  the deterministic conformance suite instead (per the e2e "backend side-effects belong in
  conformance" rule), not by adding fake-tracker plumbing to the browser suite.
- **Consistency fix carried in this PR:** `RecurringPipelineService.create` now emits a best-effort
  `boardChanged('block-added')` when it materialises the reused block — every OTHER block creation
  (`BoardService.addTask`, frame/module adds) already does, so a schedule-created task previously
  failed to appear live on other open boards. Wired through the orchestration container's resolved
  `executionEventPublisher` (symmetric across both runtimes by construction); the new e2e spec is
  what exercises it end to end.
- Added a `bug-intake` `SYSTEM_AGENT_META` display entry in the SPA catalog (mirroring `tracker`,
  its outbound dual) so it renders on run timelines / saved pipelines; `bug-investigator` /
  `repro-test` already arrive as registered `customAgentKinds`. No new i18n keys — pipeline names
  aren't localized and no template-value-keyed strings exist.

## Conventions & gotchas carried between iterations

- **Decisions already made — do not re-litigate**: `availability` is a tri-state enum on
  the pipeline definition (not a label convention); intake config is **schedule-scoped**
  (not per-frame, not per-pipeline); clarification reuses `clarity-review` (no new gate
  archetype); a `repro-test` concession NEVER fails the run; no-match is a silent no-op
  success; clarification answers are in-app only (the tracker comment is an echo);
  full multi-repo (service-connections Phases 3–4) is in scope, per-user decision.
- **Runtime symmetry is per-PR**: every new column/behaviour lands D1 ⇄ Drizzle with a
  conformance assertion in the SAME PR. `pipeline_schedules` changes need a fresh D1
  migration and a `pnpm db:generate` Drizzle migration.
- **No N+1**: the intake dedupe against the `tasks` projection is one batched read;
  predicates are pushed into the vendor query (JQL / search qualifiers / GraphQL filter),
  never fetch-all-then-filter.
- **Most phases are harness-free** (backend TypeScript + registered kinds), but a genuinely new
  container CAPABILITY needs a harness change + image bump per the CLAUDE.md rules (bump
  `@cat-factory/executor-harness` + `pnpm sync:image-tags`): Phase B (sibling checkouts), Phase F
  (read-only multi-repo explore), and Phase G (structured output on the coding surface). Phases
  C/D/E were harness-free.
- **A parked clarification intentionally blocks subsequent fires** (the recurring
  no-overlap rule): one bug in flight per schedule. Don't "fix" this.
- **Writeback is best-effort everywhere** — a tracker outage must never fail a run.
- **Recurring runs are system-initiated**: no individual-usage (personal-subscription)
  models — already enforced by `RecurringPipelineService.fire`; don't duplicate the check.
- Changeset per PR (empty for docs-only); SPA strings through i18n with all locales in
  the same PR (the locale-parity CI gate).
- Two branches adding Drizzle migrations merge into "Non-commutative migrations": re-root
  with `node scripts/rebase-migration-snapshot.mjs <later-folder>` (see CLAUDE.md).
- **The multi-repo fan-out gate** — the executor keeps a small allow-list of PRE-REGISTRY
  built-ins (`coder`, `ci-fixer`), but a REGISTERED kind opts in via `fanOutMultiRepo: true` on
  its definition (the `bug-investigator` in Phase F, and now `repro-test` in Phase G), so neither
  needed an allow-list edit. `repro-test` rides the EXISTING coding fan-out (`runMultiRepoCoding`)
  since it commits — no new harness path like Phase F's read-only `runMultiRepoExplore`. What Phase
  G DID add to the harness is structured-output parsing on the coding path (see the Phase G notes)
  — the coding fan-out gained the same `custom` parse as the single-repo coder.
- **The harness's multi-repo paths are deliberately simpler than the single-repo ones**: the
  coding fan-out (`runMultiRepoCoding`, per PR #752) has no mid-run checkpoints / warm pool /
  follow-up streaming, and the read-only explore fan-out (`runMultiRepoExplore`, Phase F) just
  clones siblings + runs once at root + parses (no branches/push/PR). `repro-test` will run
  through the coding path once multi-repo — don't design Phase G around checkpoint/streaming
  behaviour that only exists on the single-repo side.
- Phase 4 of service-connections (= Phase C here) must also extend the gate-helper agents
  (`ci-fixer`, `conflict-resolver`) to emit `peerRepos` — PR #752 only wired the `coder`
  path; the `ci`/`conflicts` gates' helper dispatch (`onPr`) doesn't yet know about peers.

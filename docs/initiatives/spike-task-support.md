# Initiative: Spike task support (research → findings document, no code)

## Goal & rationale

A **Spike** is a timeboxed analysis/research task: the agent investigates a question against
the given context (task description, linked docs, the codebase) and a set of criteria, and
produces a **findings document** — no code change, no PR. The task type already exists on the
create form (`taskTypeSchema` in `backend/packages/contracts/src/primitives.ts:73`, with a
`timeboxHours` field at `:127` and its own icon + timebox input in `AddTaskModal.vue`), and a
`document`-type frame even restricts its tasks to `document`/`spike`
(`BoardService.ts:497-504`) — but behind the picker the type is a **hollow shell**:

- **It runs the wrong pipeline.** `defaultPipelineIdForTaskType`
  (`backend/packages/kernel/src/domain/seed.ts:726-728`) special-cases only `document`;
  `spike` returns `undefined` and falls through to the workspace **positional default —
  `pl_full`, a full code+PR build** (`ExecutionService.ts:2886-2899`). Unless the user
  manually pins a pipeline, a "research task" dispatches a coder and ends in a merge tail.
- **Even a hand-authored research-only pipeline cannot terminate.** A task-level run whose
  pipeline has no `merger` ends with the block at **`pr_ready`, never `done`**
  (`RunStateMachine.finalizeBlock`, `RunStateMachine.ts:460-480`), and raises a
  `pipeline_complete` notification whose copy asserts a PR was opened and whose only human
  action (confirm → merge) **throws `no_pr_to_merge`** on a PR-less block
  (`ExecutionService.ts:3211-3215`). The spike is permanently stuck.
- **The findings have no durable home.** A run's non-code output survives only as
  `step.output`/`step.custom` on the execution instance; the imported-documents surface is
  external-source/import-only (no service writes a `DocumentRecord` from a run result).
- **No agent kind performs the work.** Every adjacent kind is domain-specific (`analysis` =
  tech-debt audit, `bug-investigator` = bug root-cause, `business-reviewer` = drift report,
  `doc-researcher` = an inline brief feeding a doc writer). Nothing consumes "context +
  criteria + timebox → findings".

The good news: **all the machinery exists** — read-only `container-explore` kinds with
structured or prose output, post-ops that commit files via `RepoFiles.commitFiles` **without
opening a PR** (the `blueprints` post-op commits straight to the default branch), a markdown
prose reader with ToC for step output, and the result-view seam. The gaps are wiring,
terminal-state semantics, and UX — enumerated and prioritized below.

## Target pattern (reference implementations to copy)

- **Read-only structured research kind**: `bug-investigator`
  (`backend/packages/agents/src/agents/kinds/bug-investigator.ts`) and the `security-auditor`
  worked example (`backend/internal/example-custom-agent/src/index.ts:299-322`) —
  `container-explore` + `defineStructuredOutput` + `READ_ONLY_AGENT_KINDS` guardrail +
  `generic-structured` result view.
- **Commit a rendered document with NO PR**: `renderReportPostOp`
  (`example-custom-agent/src/index.ts:141-153`) and the `blueprints` post-op
  (`backend/packages/agents/src/repo-ops/builtin.ts:85-110`) — parse `result.custom`, render
  Markdown, idempotent `commitFiles` onto `block.pullRequest?.branch ?? baseBranch`.
- **Inline prose findings surfaced in the UI**: `business-reviewer`
  (`backend/packages/agents/src/agents/prompts/business-logic.ts:93-117`) — `step.output`
  prose rendered by `AgentStepDetail.vue`'s markdown reader.
- **Type→pipeline default**: the `document` branch of `defaultPipelineIdForTaskType`
  (`seed.ts:726-728`) + `BoardService.addTask` (`BoardService.ts:569-573`).
- **Per-`DocKind` creation fields folded into the brief**: the `research` doc-kind fields
  `researchQuestion`/`optionsToCompare` (`primitives.ts:172-175`) and their consumption in
  `backend/packages/agents/src/agents/kinds/document.ts:117-160`.
- **Dedicated result window (if warranted)**: the result-view seam — `resultView` id in
  `catalog.ts` → `STEP_RESULT_VIEWS` in `StepResultViewHost.vue:33-71`.

## Prioritized gap register

Statuses: `todo` / `in-progress` / `done`. Update (+ PR link) at the end of each PR.

### P0 — a spike cannot run correctly or finish today (showstoppers)

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                 | Proposed direction                                                                                                                                                                                                                                                                                                                                                                                             | Status | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 1   | **No spike agent kind.** Nothing performs "investigate context against criteria, emit findings"; adjacent kinds are all domain-specific (`analysis`, `bug-investigator`, `business-reviewer`, `doc-researcher`).                                                                                                                                                    | Register a built-in `spike` kind via `registerAgentKind`: `container-explore` (read-only), structured output (question, findings, options compared, recommendation, open questions, confidence) + prose body; prompt consumes description + `contextDocs`/`contextTasks` + the spike fields (see #7).                                                                                                          | todo   |     |
| 2   | **No spike pipeline and no type→pipeline default.** `defaultPipelineIdForTaskType` handles only `document` (`seed.ts:726-728`); a spike falls through to the positional default `pl_full` and dispatches a coder.                                                                                                                                                   | Seed a built-in `pl_spike` (e.g. `requirements-review(gate,off-by-default) → spike`) and add the `spike → pl_spike` branch to `defaultPipelineIdForTaskType`. No `conflicts → ci → merger` tail — nothing to merge.                                                                                                                                                                                            | todo   |     |
| 3   | **Task-level no-merger runs terminate at `pr_ready`, not `done`, with an un-clearable notification.** `finalizeBlock` (`RunStateMachine.ts:460-502`) hard-codes the "opened a PR, confirm merges it" story; confirm throws `no_pr_to_merge` (`ExecutionService.ts:3211-3215`). Note frame-level blocks already reach `done` cleanly (`RunStateMachine.ts:438-457`). | Add a no-PR terminal path: when the finished run produced no PRs (`allPullRequests(block)` empty), either set the task block `done` directly or raise a `findings_ready`-style notification whose confirm completes WITHOUT calling the merge path. Fix the `pipeline_complete` copy to stop asserting a PR. This is engine-level and benefits every PR-less pipeline (e.g. a bare `pl_environment_analysis`). | todo   |     |

### P1 — the findings deliverable (durability + fidelity)

| #   | Gap                                                                                                                                                                                                                                                                                                                            | Proposed direction                                                                                                                                                                                                                                                                                                                        | Status | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 4   | **No durable findings sink.** Output survives only as `step.output`/`step.custom` on the run; the documents surface is import-only (`DocumentRepository` writers are `DocumentImportService`/`DocumentLinkService` only). A later reader must dig through run history.                                                         | Give the `spike` kind a post-op that renders the structured findings to Markdown and `commitFiles` it to `docs/research/<slug>.md` on the base branch (the `blueprints`/`security-auditor` shape; honour `taskTypeFields.targetPath` when set). `step.output` keeps the readable digest for the UI. See open decision D1.                 | todo   |     |
| 5   | **`timeboxHours` is inert.** Stored in `taskTypeFields` and threaded onto agent context (`AgentContextBuilder.ts:350`) but no prompt section renders it and nothing enforces it — the one spike-specific field does nothing.                                                                                                   | Render the timebox into the spike prompt as a scope-discipline directive ("size the investigation to ~N hours; prefer breadth-then-depth; list what you deliberately did not chase"). Optionally map it onto the harness job watchdog budget.                                                                                             | todo   |     |
| 6   | **Repo coupling is wrong for research.** A container kind on a block under an unlinked service fails the run (`resolveRepoTarget` throws — `repoFiles.ts:184-187`), and with GitHub unwired post-ops are **silently skipped** (`RunDispatcher.ts:2549-2555`) — committed findings silently lost while the run reports success. | Decide + implement the repo-less story: at minimum a clean precondition error (not a silent skip) when the spike's post-op cannot commit; ideally allow a docs-only spike (contextDocs grounding, inline or container-explore against no repo) to run and settle on `step.output` alone.                                                  | todo   |     |
| 7   | **Spike creation collects no research criteria.** Only the timebox; `researchQuestion`/`optionsToCompare` exist solely under the `document` type's `research` doc-kind (`primitives.ts:172-175`). "Given context and criteria" has nowhere to be given.                                                                        | Add spike fields to `taskTypeFieldsSchema` (research question, success/acceptance criteria or decision sought, options to compare — consider sharing the existing research keys) + the `AddTaskModal.vue` per-type section, folded into the spike prompt like `document.ts:117-160` does. i18n: all locales in the same PR (parity gate). | todo   |     |

### P2 — surfacing, guard-rails, coverage

| #   | Gap                                                                                                                                                                                                                                                                                                             | Proposed direction                                                                                                                                                                                                                                                                               | Status | PR  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --- |
| 8   | **Terminal/reading UX is PR-shaped.** `TaskExecution.vue` treats "no PR" as nothing-to-show (`:46-52`), success vocabulary is `pr_ready`/"Merge PR" (`catalog.ts` STATUS_META, `TaskCard.vue` merge button); there is no "view findings" affordance and no findings viewer beyond the generic step prose panel. | Add a findings affordance on the done spike (inspector + card): open the findings via the result-view seam — either `generic-structured` or a small dedicated `spike-findings` markdown window (registered in `STEP_RESULT_VIEWS`); link the committed `docs/research/...` file when one exists. | todo   |     |
| 9   | **No-PR misbehaviour in merge-tail steps** (guard-rails, mostly relevant if users hand-compose pipelines): a `merger` on a PR-less block silently flips it `done` with no merge (`ExecutionService.ts:2795,2809`); the `human-review` gate waits forever when the PR is missing (`gates.ts:559-561`).           | Make `merger` on a PR-less block an explicit no-op with a logged/notified reason (or a `validatePipelineShape` warning for merger-without-code-producer); make `human-review` pass through when there is no PR to review.                                                                        | todo   |     |
| 10  | **Spike vs `document`+`docKind: research` overlap.** `pl_document` already authors research docs — but commits via `doc-writer` + a full `conflicts → ci → merger` PR tail. Two half-overlapping notions of "research task" will confuse users and future maintainers.                                          | Document the boundary in the spike kind/pipeline docs: **spike** = timeboxed investigation, findings committed directly (no PR, no review tail), fast; **document/research** = a curated, reviewed, PR-merged document. Cross-link from `AddTaskModal` copy if needed.                           | todo   |     |
| 11  | **No coverage.** Nothing asserts a research-only pipeline reaches a terminal state; the conformance suite has no PR-less-run assertions, and e2e has no spike spec.                                                                                                                                             | Conformance: drive `pl_spike` via `FakeAgentExecutor` on both runtimes — assert block reaches `done`, findings on `step.output`/`step.custom`, post-op commit invoked (both facades). E2e: create spike → run → findings visible live (per the e2e spec rules; add `data-testid`s as needed).    | todo   |     |

## Suggested slicing (each ≈ one PR)

1. **Phase A** — gaps 1 + 2 (+ the prompt side of 5): the `spike` kind, `pl_spike`, the
   type default. Lands the happy path up to the terminal-state wall.
2. **Phase B** — gap 3 (+ the copy part of the `pipeline_complete` fix): the engine's no-PR
   completion path. Independent of Phase A; unblocks every PR-less pipeline.
3. **Phase C** — gaps 4 + 6: the findings post-op + the repo-less/silent-skip story, with
   conformance assertions (gap 11's backend half) in the same change.
4. **Phase D** — gap 7: spike creation fields + prompt folding + i18n.
5. **Phase E** — gaps 8 + 10: SPA terminal UX + findings viewer + the spike/document
   boundary docs.
6. **Phase F** — gaps 9 + 11 (e2e half): guard-rails and the e2e spec.

## Open decisions

- **D1 — canonical findings home.** Recommended: in-repo commit (`docs/research/…`) via a
  no-PR post-op, mirroring `blueprints` ("the repo is the source of truth, the board is the
  projection") + `step.output` for the UI. Rejected-by-default alternatives: extending the
  imported-documents table (it is deliberately external-source-scoped — every row carries a
  provider `source`; adding an "internal" source reshapes that model) or a brand-new
  findings table (new D1⇄Drizzle parity surface for data the repo can already hold). Revisit
  only if repo-less spikes (gap 6) become the primary use case.
- **D2 — structured vs prose output.** Structured (recommendation/options/confidence) enables
  a real result view and future "verdict gate"-style policy (cf. the latent family noted in
  CLAUDE.md's gates section); prose is cheaper and renders today. Recommended: structured
  with a mandatory prose `findings` body — both surfaces work.
- **D3 — does `pl_spike` end in a human gate?** A timeboxed spike arguably wants a human
  acknowledgement ("findings reviewed") before `done`. If yes, that is exactly the
  `findings_ready` notification variant of gap 3 rather than auto-`done`.

## Conventions & gotchas (carry between iterations)

- **Frame-level runs already finish cleanly** (`RunStateMachine.ts:438-457` → `done`); only
  task-level blocks hit the `pr_ready` wall. Don't "fix" the frame path.
- **The built-in gates degrade gracefully on PR-less blocks** — `ci` aggregates zero checks
  to `none` → pass (`gate-logic.ts:120-137`), `conflicts` explicitly passes with no open PR
  (`gates.ts:154-162`) — so leaving a stray gate in a research pipeline is harmless; the
  exceptions are `merger` and `human-review` (gap 9).
- **`requirements-review` needs no repo/PR** (pass-through when unwired; RepoFiles used only
  as optional grounding) — safe as the first step of `pl_spike`.
- **`validatePipelineShape` does not require coder/merger** (`pipelineShape.ts:62-66`) — a
  research-only pipeline is already valid to author; no validator work needed for Phase A.
- **Post-ops are skipped silently when GitHub is unwired but THROW on an unlinked service**
  (`RunDispatcher.ts:2540-2555`, `repoFiles.ts:184-187`) — two different failure modes to
  handle in gap 6; don't conflate them.
- **Registered kinds' structured JSON lands on `AgentRunResult.custom` → `step.custom`**
  via the default branch of `toRunResult` (`containerAgentResult.ts:108-111`) — a new
  built-in `spike` kind can ride that as-is; only add a well-known field if the engine
  itself must read the findings (it shouldn't need to).
- Built-in pipelines are versioned, read-only templates (`builtin: true`, `version`) —
  bump the version on any later step-list change to `pl_spike`.
- Keep the runtimes symmetric: any new persistence or wiring lands D1 ⇄ Drizzle with a
  conformance assertion in the same change (none is expected if D1 stays "no new table").

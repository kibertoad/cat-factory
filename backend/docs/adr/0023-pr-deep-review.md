# ADR 0023: "Review" task type; scalable deep review of an open PR

- **Status:** Accepted (implemented)
- **Date:** 2026-07-15
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/server`, both runtime facades) + frontend (`@cat-factory/app`)

## Context

cat-factory had no first-class way to **deep-review an existing, already-open pull request**,
especially a massive one (hundreds of changed files). The build-pipeline `reviewer` companion
only rates the coder's own change inside a run, and the `human-review` gate only watches a PR for
human approvals. Neither reviews an arbitrary large PR the way Claude Code's `/review` does, and
neither is mindful of the token blow-up a 500-file diff causes in one context window. A reviewer
that stays cheap and thorough on huge PRs, keeps a human in the loop over which findings matter,
and can then act on the selection was missing.

## Decision

A **`review` task type** (`taskType: 'review'`) with a dedicated pipeline (`pl_review`, id
`REVIEW_PIPELINE_ID`) whose single step is a read-only container agent, the **`pr-reviewer`**
kind (`container-explore`). Rather than reading the whole diff into one context, its prompt
**slices** the change into cohesive groups (a refactor + its call sites + its tests) from the
cheap `--name-status`/`--stat` signals and reviews **one slice at a time** in Pi's agentic loop,
so token usage scales with the slice budget, not the whole PR while retaining full-source access
(follow a call site, read an unchanged neighbour). It returns `prReviewAgentOutputSchema` (slices +
severity-ordered findings) as `result.custom`.

The engine coerces that output (`coercePrReview`: mint ids, anchor findings to slices,
severity-sort) onto **`step.prReview`** and, via the `pr-review` completion interceptor, **parks**
the run for a human to multi-**select** which findings matter through the dedicated `pr-review`
result-view window. The human then resolves the parked review one of three ways
(`resolvePrReviewSchema.action`):

- **`finish`**: record the curated selection and advance past the gate (no side effect).
- **`fix`**: re-arm the same `pr-reviewer` step (mirroring the fork-decision phase-B re-dispatch)
  so the durable driver re-dispatches it as the **Fixer** (`FIXER_AGENT_KIND`, `container-coding` +
  `clone:{branch:'pr'}`): the engine resolves the reviewed PR's head branch (via the
  checkout-free `RepoFiles.pullRequestHeadRef`) and folds a synthetic `pullRequest` + an apriori
  WORKING branch into the dispatch context so the Fixer clones + pushes that branch, with the
  selected findings rendered into its prompt (`renderPrReviewFixerFeedback`). The Fixer's
  completion marks the review `done`.
- **`post`**: re-arm with an at-most-once `pendingPrReviewPost` marker so the driver publishes the
  selected findings on the PR via `RepoFiles.createReview`, which posts each inline comment
  INDIVIDUALLY (not one atomic batched review) plus the summary as a general comment. Before
  posting, `computeCommentableLines` parses the PR diff so a finding anchored to a line OUTSIDE the
  diff is folded into the summary (the root-cause fix for GitHub's "Line could not be resolved" 422) rather than sent as a comment GitHub rejects. And before that, a **branch-drift** check: the PR
  head sha captured when the reviewer was dispatched (`reviewedHeadSha`) is compared to the PR's
  CURRENT head; if the branch moved since the review started, EVERY finding is folded into the
  summary (its frozen line number may now point at shifted code) instead of anchored inline. The
  per-comment outcome is reduced to a
  `step.prReview.postReport` (how many of how many posted, per-finding failures, folded count) the
  window renders. A FULLY successful post finishes the step `done`; ANY partial/failed post
  RE-PARKS the run at `awaiting_selection` carrying the report, so the human sees what happened and
  can retry ONLY the posting (re-`post`, which skips findings already in `postedFindingIds`) or
  switch to `fix`/`finish`: never a stuck spinner or an opaque whole-run failure.

All review state rides `step.prReview` (**no side table**), so it is runtime-symmetric by
construction, exactly like `forkDecision`/`followUps`. The two VCS reads/writes the resolutions
need (`getPullRequestHeadRef`, `createReview`) are new **optional** methods on the neutral
`VcsClient` + `GitHubClient` ports (GitHub-implemented via `FetchGitHubClient`, forwarded by
`vcsBackedGitHubClient`, omitted on GitLab), surfaced to the engine through the existing
`RepoFiles` seam (`resolveRunRepoContext`).

## Rationale

- **Container agent as the review substrate, not an inline manifest-Slicer.** The original plan
  had an inline LLM Slicer over a compact file manifest + a per-slice inline reviewer. It was
  dropped: the container `pr-reviewer` already keeps per-slice context bounded in Pi's loop **while
  retaining full-source access**, which a patch-only inline reviewer can't. The inline Slicer's
  only unique win (a provably-linear token ceiling) wasn't worth the review-quality loss. It may
  return as an opt-in pre-slicer for pathological PRs; if so it must receive the manifest only
  (never full patches), with a mechanical directory-grouping fallback. `listChangedFiles` was
  landed as its data source and is now also consumed by the `pr-reviewer` preOp, which injects the
  changed-file list + patches as `.cat-context/pr-diff.md` so the container agent skips the
  reconstruct-the-diff turns (see `docs/initiatives/pr-review-turn-reduction.md`): an accelerant
  layered ON the full-clone container review, not the dropped patch-only inline design.
- **Comment-aware: de-dup against findings already on the PR.** A re-review (a `fix` round, a
  second pass) used to review the diff cold and re-surface issues already raised, answered, or
  dismissed in earlier comments: noise on the exact PRs where a human wants only what changed. A
  second `pr-reviewer` preOp reads the PR's existing review threads via the checkout-free
  `RepoFiles.listReviewThreads` (the same GraphQL read the `human-review` gate uses, surfaced on the
  `RepoFiles` seam) and injects them as `.cat-context/pr-existing-comments.md`: each thread's
  anchor, resolved state and opening comment. The prompt then tells the reviewer to skip an issue an
  existing comment already covers (unresolved = awaiting action; resolved = only re-raise if the fix
  is wrong) and spend the review on what is new. It reuses the existing optional `listReviewThreads`
  method already implemented on `FetchGitHubClient` and forwarded by `vcsBackedGitHubClient`, so
  GitLab gets it for free; a client that can't read threads omits the method and the preOp passes
  through (the reviewer reviews cold, exactly as before). Because this file is third-party prose
  (any human/bot that can comment on the PR authored it) and the feature deliberately tells the
  reviewer to DEFER to it (skip what it covers), the prompt fences it as untrusted data: the
  reviewer is told to use it only to avoid repeating findings and to ignore any instructions inside
  it (steer the verdict, suppress findings, approve). The blast radius is bounded regardless: the
  reviewer is a read-only `container-explore` kind, so a hostile comment can at worst distort the
  review output, never merge or mutate the repo.
- **State-on-step + park/resolve mirror the fork-decision flow.** The `fix` resolution reuses the
  proven `choose`-style re-arm (`resetStepForRerun` + `startStep` + `signalDecision`), and `prReview`
  survives `resetStepForRerun` exactly like `forkDecision`. This kept the whole feature free of a
  new persisted table and automatically cross-runtime-symmetric.
- **Reuse `FIXER_AGENT_KIND` verbatim.** Because a `review` task carries no own work branch, the
  engine synthesises the PR head branch into the dispatch context (via an apriori working branch so
  the work-branch machinery targets it, probed not created; no orphan `cat-factory/<blockId>`
  branch), so the unchanged `container-coding` + `clone:{branch:'pr'}` fixer body clones and pushes
  the reviewed PR's branch.
- **Per-comment posting for partial success + observability.** The original design submitted one
  atomic batched `COMMENT` review, which is all-or-nothing: a single finding anchored to a line
  outside the diff 422s ("Line could not be resolved") and rejects EVERY comment, and the step then
  failed the whole run with the error only visible after closing the window: a de-facto stuck
  spinner. `createReview` now posts each inline comment individually (a standalone review comment)
  and the summary as a general comment, reporting a per-comment `CreateReviewResult`. So the
  anchorable comments land while the rest are reported, and the deep-review window shows "N of M
  posted" + the per-finding failures: the observability this resolution needed.
- **Resolve the 422 at the source.** `computeCommentableLines` parses each changed file's unified
  diff into the set of lines an inline comment can anchor to (added/context on the RIGHT, removed/
  context on the LEFT); `buildPrReviewPost` folds any finding whose line falls outside that set
  into the summary comment instead of sending an inline comment GitHub would reject. The per-comment
  posting is then the safety net for anything the pre-filter can't catch (a null-patch/too-large
  file, an API edge).
- **Guard against position drift when the branch moves.** The per-line diff filter above catches a
  finding whose line fell OUT of the current diff, but not one whose line number is still a valid
  diff line yet now points at DIFFERENT code after a push. So the reviewer's first dispatch captures
  the PR head sha (`reviewedHeadSha`, a best-effort one-call `pullRequestHeadSha` read; skipped when
  the VCS client can't read it, leaving the check inert), and `post` re-reads the current head: on a
  mismatch it treats every finding as unanchorable (`buildPrReviewPost({ staleHead: true })`) and
  folds them all into the summary comment, so a moved branch can't scatter comments onto shifted
  lines. Unknown-sha on either side (older run, read blip) degrades to the pre-existing behaviour.
  The `pr-reviewer` is always a container (async) kind, so the capture rides the async dispatch
  path; the same review-start head is resolved through the SHARED `resolvePrNumber` the reviewer
  agent uses, so dispatch and `post` can never disagree on which PR is under review.
- **At-most-once summary, but never lose a finding.** `post` runs in the durable driver with the
  `pendingPrReviewPost` marker consumed (cleared + persisted) before the side-effecting post, so a
  Workflows retry/replay can't re-run it; findings already in `postedFindingIds` are skipped; and the
  summary/body comment is suppressed once `postedBody` is set, so a human RE-`post` (the retry path)
  never double-posts an inline comment OR the summary that already landed. The one subtlety the
  drift guard adds: a finding that first FAILED to post inline and then drifted is now folded into
  the body, which would be lost if the body were blanked because the summary already landed. So the
  suppression is scoped: on a stale-head retry the body is still posted (carrying only the newly
  folded findings, `buildPrReviewPost({ summaryAlreadyPosted: true })` dropping the already-landed
  summary prose to avoid a duplicate). The at-most-once-summary and always-deliver-the-findings
  guarantees are thus kept independent. A partial/failed post
  RE-PARKS at `awaiting_selection` carrying the `postReport` (never a `job_failed`), so the failure
  is legible and retryable in place; the human doesn't re-run the whole review. To keep GitHub from
  rejecting a blank-body comment, `buildPrReviewPost` always emits a non-empty `body` (falling back
  to a count of the inline comments when neither a summary nor a folded/unanchored finding supplies
  one).
- **Pass-through when unwired.** A clean PR (no findings) records an empty `done` review and lets
  the normal spine finish (no park); an unwired reviewer / no VCS write degrades gracefully. The
  cross-runtime conformance suite asserts the park → select → resolve loop for all three actions.

## Per-finding curation: dismiss + challenge (follow-up)

The park→select→resolve loop was extended with two per-finding actions in the deep-review window,
so a human curates the findings themselves, not just which to act on:

- **Dismiss** (`POST /executions/:id/pr-review/findings/:findingId/dismiss`) drops a finding
  entirely, pruning it from `findings` + `selectedFindingIds` + `postedFindingIds`. It is pure
  curation: the run stays parked at `awaiting_selection` (no re-arm, no signal), a synchronous
  mutation of `step.prReview`.
- **Challenge** (`POST …/findings/:findingId/challenge`, optional `{ question }`) dispatches a new
  read-only **`challenge-investigator`** agent kind (`container-explore`, base full clone: the
  `pr-reviewer` template) against the ONE finding. It rides the SAME re-arm the `fix`/`post`
  resolutions use (`resetStepForRerun` + `startStep` + `signalDecision`), recording
  `step.pendingChallenge = { findingId, question }` and moving the review to a new `challenging`
  status; the driver's `pr-review-resolution` handler dispatches the investigator with the finding +
  the human's concern (or a generic "dig deeper + validate" prompt when blank) folded in as a
  prior output. The investigator returns `prReviewChallengeOutputSchema` (a lenient uphold/retract
  verdict + optional `revised*` fields), which a dedicated `pr-review-challenge` completion
  interceptor (ordered BEFORE `pr-review` so it wins during a challenge) applies to the finding via
  `applyChallengeVerdict`: a kept finding records `amended` ONLY when a `revised*` field actually
  changed its body, else `upheld` (held as written, so the window never falsely shows
  "Strengthened"); `retracted` records a `retracted` challenge with its justification AND
  auto-deselects the finding (it can never be fixed/posted/finished: `resolve`'s selectable set
  excludes retracted findings, and a retracted finding can't be re-challenged either). The review
  then re-parks at `awaiting_selection`. If the investigator's job FAILS (a genuine crash, after any
  container-eviction retry budget), the driver's failed-job path settles the challenge `failed` via
  `PrReviewController.recordChallengeFailure` (the analogue of the human-test / visual-confirmation
  helper-failure branch); the finding is left untouched and the review re-parks, so a non-critical
  second opinion crashing on ONE finding never fails the human's in-flight curation. A finding carries
  its challenge lifecycle on `PrReviewFinding.challenge` (`investigating` → `upheld` | `amended` |
  `retracted` | `failed`), rendered in the window (a spinner while investigating, a badge + the
  investigator's justification once settled). All of this rides `step.prReview` /
  `step.pendingChallenge`: still NO side table, so it stays runtime-symmetric, asserted by the
  conformance suite (dismiss, challenge-retract, challenge-uphold-strengthen, challenge-uphold-as-is,
  and challenge-investigator-failure).
- **Separately-configurable model.** Because the investigator dispatches under its OWN agent kind
  (`challenge-investigator`, via the `handleAgentStep` dispatch-kind override), model routing keys
  off it, so a workspace can point it at a different (stronger) model than the reviewer through a
  per-kind model-preset override, with no new plumbing (it appears in the Model Defaults panel).

## Durable per-slice capture + a manual resume (follow-up)

The park→select→resolve loop assumed the reviewer reaches its aggregation pass. Everything it had done before that lived only in the container's memory: `coercePrReview` runs exactly once, from the terminal `result.custom`, so a review killed at any earlier point discarded every finished slice and left a re-run from zero as the only option. The motivating run spent 18m05s and 25.46M input tokens with its final **196 seconds** in a single silent turn generating the findings JSON, during which all nine task-list entries read complete, `findings` was still `[]`, and `lastActivityAt` had frozen. Nothing in the platform could recover that state or even tell it apart from a wedge: `ProgressGuard` needs a tool call to evaluate anything, the 10-minute inactivity watchdog is reset by any subagent transcript byte, and the only backstop is the 60-minute max-duration kill, which throws the work away rather than saving it.

**A subagent's terminal report is already on the parent stream** (its dispatch and its `tool_result` both appear there; only its intermediate turns don't), and the slice tracker was matching that `tool_result` purely to flip a `done` flag while dropping the report inside it. It now keeps that report (bounded at `SLICE_REPORT_MAX_CHARS`, credential-scrubbed) and republishes the WHOLE set on the job view as each slice lands. The engine folds it onto **`step.prReview.sliceReviews`** (`applySliceReviews`), so completed review work is persisted continuously rather than at the finish line. Four properties of that channel are load-bearing:

- **Whole-value latest publish, not the drain-on-read `followUps`/`spans` use.** Those can afford to lose a poll window; this one carries the work being protected, so a dropped poll response must cost nothing.
- **The fold is monotonic** (`mergeSliceReviews`): it never demotes a `completed` slice to `in_progress` and never drops a report the incoming set omits. This is what makes the resume possible at all: the resumed container's tracker knows only the slices IT dispatched, and forwarding that verbatim would erase the previous attempt's reports.
- **Per-entry leniency**, so one malformed slice never discards the good reports beside it.
- **The reports are dropped once an aggregation CONSUMES them** (`sliceReviewsAfterAggregation`), since their content is in the findings by then and eight ~24KB prose reports is a quarter-megabyte of dead text per run row. A reviewer that returned neither slices nor findings aggregated nothing, so they SURVIVE that case; clearing there would destroy the only record of the finished slices while recording the run as a clean PR.

On top of that, **`POST /executions/:id/pr-review/resume`** (`PrReviewController.resume`, no request body) re-reviews only what never finished:

- **What to redo is derived, never supplied.** `planResumeSlices` reads the captured reports together with the previous attempt's live task list (the only place a slice that was PLANNED but never dispatched is named at all) and freezes the result onto `prReview.resumePendingSlices`, because `resetStepForRerun` is about to clear `step.subtasks`. A caller therefore cannot ask for work that contradicts what was observed. ABSENT and EMPTY differ deliberately: empty is a real resume whose every planned slice reported (the incident's own shape, where only the aggregation wedged), absent means the resume observed no prior work at all and is an honest restart.
- **The prior reports reach the resumed agent as `.cat-context/pr-prior-review.md`**, rendered by `renderPriorReviewContext`, which names the already-reviewed slices, reproduces each report verbatim, names the remaining slices, and states that a slice which finished with no readable report is still DONE (saying nothing would read as never dispatched). The reviewer's prompt tells it to fold those findings into its final aggregate: the only place they can land, since the reports are dropped once it does.
- **The BUILDER emits that file, not a preOp** beside the reviewer's other three. The state rides the STEP, which `RepoOpContext` deliberately does not carry, and a preOp only runs once a run repo RESOLVES, which this file needs no part of, so gating on it would silently turn a resume back into a from-zero re-review on a deployment whose repo context is unwired. `AgentRunContext.injectedContextFiles` consequently has two producers that ACCUMULATE; `RunRepoOpsController` appends rather than assigns.
- **Re-entry is `stopRunContainer` → reset → start, with no decision signalled.** The driver gates both halves of its loop on `step.jobId`, so clearing it is enough: the in-flight driver re-dispatches on its next poll tick. `resolve`'s `fix`/`post` path signals because it is parked on a decision; this one is not, and signalling would risk a second concurrent dispatch. The container is reclaimed BEFORE the CAS (the mutate body stays pure, stopping is idempotent) because leaving the wedged agent running would double-spend against the same PR.
- **`prReview.resumeAttempts` feeds the step's DISPATCH EPOCH.** A container-reusing transport re-attaches to a known job id rather than re-running, and the reviewer step carries none of the loop counters (`test`/`gate`/`ralph`) the epoch is otherwise derived from, so without this term every resume would mint the same id and hand the "recovery" straight back to the wedged job.
- **`reviewedHeadSha` is preserved.** It records the head the findings were computed against, and the completed slices' findings were computed against that tree; re-stamping it would claim otherwise and silently re-enable inline anchoring on lines that may since have shifted. A long resume therefore widens the drift window, which `post` already handles by folding drifted findings into the summary.
- **Refused (409) unless the review is still `reviewing`.** A parked or resolved review has its own actions, and re-dispatching one would destroy findings a human may be mid-selection on.

The window offers `Resume` throughout the `reviewing` phase, including the neutral PLANNING sub-state, and deliberately does NOT gate it on a staleness heuristic: `lastActivityAt` freezes on a long silent turn, so the platform cannot tell a wedged review from a quiet-but-working one, and hiding the control until it thinks it can would put it out of reach in exactly the case that motivated it.

**Still unaddressed.** The frozen heartbeat itself. A synthetic keep-alive beat would defeat the inactivity watchdog, which is the only thing that kills a genuinely hung agent; real activity needs `--include-partial-messages` plus a rework of the call aggregator's `message.id` folding, which is its own change. Until then the captured reports are the tell: every slice `completed` with `findings` still empty means aggregating, not stuck, and the resume is now the escape hatch either way. See [ADR 0026](./0026-pr-review-observability-and-pool-isolation.md) and [ADR 0027](./0027-pr-review-observability-followup.md) for the observability history this sits on.

## Consequences

- A read-only pipeline (`pl_review`) finishes `done` with no PR-assuming card; the no-PR terminal
  path in `RunStateMachine.finalizeBlock` handles it.
- **The `reviewing` status is seeded at dispatch, not just on completion.** The engine seeds
  `step.prReview = { status: 'reviewing', prUrl, model, … }` (`initialPrReviewState`) the moment the
  reviewer's container job dispatches (the `recordFindings` interceptor already treated `reviewing`
  as "not yet recorded" and coerces over it), so the deep-review window renders a real in-flight
  phase instead of an empty panel. The reviewer's prompt maintains a per-slice todo list, which
  surfaces as the step's live `subtasks`; the window uses the presence of that list to tell the two
  `reviewing` sub-phases apart: a neutral PLANNING state (no per-slice todo plan reported yet; the
  reviewer may still be grouping the diff, OR reviewing via parallel subagents that never write a
  parent plan) vs REVIEWING (a per-slice plan exists). In the reviewing sub-phase it
  lists every chunk with an explicit status (Reviewed / Reviewing… / Queued) plus a "Reviewing now"
  callout for the in-progress chunk(s), rather than a bare slices-reviewed count or "agent running".
  The UI never asserts a specific "slicing" phase purely from an empty todo list (ADR 0026 D2.2).
  The same sub-phase is surfaced compactly on the **board**: the task-card mini pipeline and the
  focus-view timeline render a `PrReviewPhaseBadge` ("Reviewing…" / "Reviewing X/Y slices", plus the
  awaiting / investigating / fixing / posting states) in place of the generic subtask count, derived
  by the pure `prReviewPhase` helper (a sibling of `hasNoSlicePlan`, unit-tested in
  `prReviewProgress.spec.ts`). The window itself also carries the shared `StepRunMeta` run-details
  block (elapsed / model / run id + the LLM call/token rollup), so the reviewer's run reads the same
  "which run / how did the model do" facts as the generic step detail and the gate/tester windows.
- **The slice fan-out is bounded, and the live list is a MERGE of the plan and the dispatches.** The
  reviewer keeps at most `MAX_PARALLEL_SLICE_SUBAGENTS` (5) slice subagents in flight and dispatches
  the next queued slice as one returns; an unbounded wave buys provider rate-limiting rather than
  speed. The harness folds the parent's task list (the inventory, and the only place a queued slice
  is named) together with the subagent dispatches (the live status) rather than picking whichever
  looks further along; picking made the rendered list collapse to the dispatched slices the moment
  the first subagent returned. Both are recorded as Defect D in
  [ADR 0027](./0027-pr-review-observability-followup.md).
- **Same-repo, non-fork PRs only.** The reviewer clones the service's linked repo and fetches the
  PR head by number, and the Fixer pushes to that head branch, so the `fix` resolution requires a
  PR on the service's own repo the platform can push to. A cross-repo `prUrl` (a PR on a different
  repo than the service's) and fork PRs are **deliberately not** resolved yet; the create form's
  target is effectively "a PR on this service's repo" (URL or `#number`), and `post` is the
  fallback when a PR can't be pushed to. Resolving `prUrl` → owner/repo/number server-side is a
  future follow-up.
  - **That constraint is now ENFORCED at creation, not merely documented.** `BoardService.addTask`
    resolves a review task's target through the same `resolveRunRepoContext` seam the run uses and
    refuses two cases before writing the block: a PR the provider positively reports as absent
    (`review_pr_not_found`), and a `prUrl` naming a different repository (`review_pr_repo_mismatch`),
    which previously reviewed whatever PR carried that number on the linked repo, silently. Only
    a positive 404 refuses: the new optional `getPullRequest` port method reports "no such PR" as
    `null` and THROWS every other failure, so an outage or a revoked token logs and passes through
    rather than making task creation depend on the provider being reachable. Every unwired case
    (no VCS connection, a provider without the capability, an unparseable reference) passes through
    too. A confirmed target is rewritten to the provider's own `url`, which is what the inspector's
    "Under review" panel links. See `orchestration/src/modules/board/reviewTaskTarget.ts`.
- GitLab omits `getPullRequestHeadRef`/`getPullRequestHeadSha`/`createReview` (optional methods), so
  the `fix`/`post` resolutions report the operation unresolvable/unsupported on a GitLab deployment
  rather than acting on the wrong repo, consistent with `listChangedFiles`. Where the head-sha read
  is absent the drift check is inert (posting keeps the per-line diff filtering). It DOES
  implement `getPullRequest` (a plain MR read it can serve), so create-time target validation is
  live on a GitLab deployment even though the `fix`/`post` resolutions are not.

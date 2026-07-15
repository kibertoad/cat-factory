# Initiative: "Review" task type — scalable deep review of massive PRs

## Goal & rationale

cat-factory has no first-class way to **deep-review an existing, already-open pull request** —
especially a massive one (hundreds of files). Today's `reviewer` kind is a _build-pipeline
companion_ that rates the coder's own change inside a run; the `human-review` gate only watches
a PR for human approvals. Neither reviews an arbitrary large PR the way Claude Code's `/review`
does, and neither is mindful of the token blow-up a 500-file diff causes in one context window.

This initiative adds a **Review** task type (`taskType: 'review'`) whose pipeline (`pl_review`):

1. **Slices a huge diff into cohesive, independent chunks** — a semantic **Slicer** groups the
   changed files into logically-linked slices (a refactor + its call sites + its tests), so
   token usage scales linearly rather than exploding one context window. The Slicer reads only a
   **compact file manifest** (paths + add/del counts + hunk headers), never full patches, with a
   mechanical pre-partition guardrail + fallback so it stays bounded on pathological PRs.
2. **Reviews each slice and aggregates + prioritizes findings** by severity (one bounded model
   call per slice; only the per-slice reviewer sees full patches, one slice at a time).
3. **Parks for a human to visually select** which findings to act on.
4. **Resolves two ways**: feed the selected findings to a **Fixer** (commits fixes onto the PR
   branch, reusing `FIXER_AGENT_KIND`), or **post them as inline PR review comments** without
   fixing.

Intended end state: a reviewer that stays cheap and thorough on huge PRs, with a human-in-the-loop
selection step and two terminal actions.

## Target pattern (reference implementations to copy)

- **Review substrate (stages 1–2) — the container `pr-reviewer` (PR 1), kept.** The full-source
  read-only agent (`backend/packages/agents/src/agents/kinds/pr-reviewer.ts`) slices + reviews
  one slice at a time in Pi's agentic loop and returns `prReviewAgentOutputSchema` as
  `result.custom`. The engine coerces it (`prReview.logic.ts` `coercePrReview` — mint ids,
  anchor findings to slices, severity-sort) onto `step.prReview`. (The original plan's inline
  manifest-Slicer + `ReviewGateController`-style inline reviewer was dropped — see the PR 2
  design note below.)
- **Propose → park → choose, state-on-step (stage 4)** — the fork-decision flow:
  `backend/packages/contracts/src/forkDecision.ts`, `ForkDecisionController.ts`
  (`recordProposal` / `choose` / async re-entry via `pendingForkChat`), `forkDecision.logic.ts`
  (`mintForks`, `buildImplementationChoice` folds the choice into the next dispatch),
  `frontend/app/app/components/panels/ForkDecisionWindow.vue` + `stores/forkDecision.ts`. ADR:
  `backend/docs/adr/0022-coder-fork-decision.md`.
- **Fixer** — `FIXER_AGENT_KIND` (`backend/packages/kernel/src/domain/gate-logic.ts`), its job
  body (`backend/packages/server/src/agents/jobBody.ts`, `container-coding` + `clone:{branch:'pr'}`,
  no new PR), and the feedback renderer `renderReviewFeedbackForFixer`
  (`backend/packages/gates/src/review.logic.ts`).
- **Task type → pipeline** — the `document` branch of `defaultPipelineIdForTaskType`
  (`backend/packages/kernel/src/domain/seed.ts`) + the `spike`/`document` chips in
  `frontend/app/app/components/board/AddTaskModal.vue`. Recent cousin initiative:
  `docs/initiatives/spike-task-support.md` (also task type + pipeline + agent kind).
- **Result-view + notification seams** — `contracts/result-views.ts` →
  `StepResultViewHost.vue`; `contracts/notifications.ts` → `NotificationService.raise` /
  `clearWaitingDecision` → `NotificationsInbox.vue` reveal.
- **VCS reads/writes** — `PullRequestReviewProvider` +
  `backend/packages/server/src/github/GitHubPullRequestReviewProvider.ts` (existing thread reads;
  the new `createReview` write is their sibling); `backend/packages/server/src/github/FetchGitHubClient.ts`.

## Conventions & gotchas carried between iterations

- **State-on-step, no side table.** All review state rides `step.prReview` (like
  `step.forkDecision`) → D1⇄Drizzle parity is free. Do NOT add a `pr_reviews` table.
- **Token guardrails are the point — met by the container agent's slice-one-at-a-time loop.**
  PR 2's decision (above) is that the full-source container `pr-reviewer` already keeps per-slice
  context bounded in Pi's agentic loop (it slices from cheap `--name-status`/`--stat` signals and
  reads one slice's files at a time), so no separate inline Slicer stage was added. If a future
  opt-in inline pre-slicer is revived, it must never receive full patches (manifest only), with a
  mechanical directory-grouping fallback.
- **Pass-through when the reviewer produced nothing.** A clean PR (no findings) — or a coerced
  empty output — records an empty `done` review and lets the normal completion finish the step
  (no park). Conformance depends on this. The park only happens with ≥1 finding.
- **Park via a completion interceptor, resolve via advance-past-gate.** The `pr-review`
  interceptor (`RunDispatcher.buildStepCompletionInterceptors`, order 106) records findings +
  parks; `PrReviewController.resolve` mirrors the review gate's resolved-gate advance
  (`advanceRunPastGate` + `settleAdvancedGate`) — it does NOT re-dispatch the reviewer. All the
  state-on-step + park/resolve shape mirrors the fork-decision flow, not the inline reviewer.
- **Runtimes symmetric.** New provider/registration wiring + `validateRegistrationsOnce` land in
  BOTH `runtimes/cloudflare` and `runtimes/node` (local inherits Node). Add a conformance
  assertion for shared behaviour.
- **No N+1.** Batch `RepoFiles.getFile` per slice; never a per-finding repo read.
- **VCS = GitHub now, neutral shape.** New methods live on the neutral `VcsClient` + `GitHubClient`;
  GitHub-implemented; `FetchGitLabClient` throws "unsupported" for now.
- **i18n locale parity.** Any `en.json` key touched must be mirrored in every other locale in the
  SAME PR (the parity gate), with real translations — never an English placeholder.
- **Cross-repo `prUrl` is NOT yet resolved (follow-up).** PR 1 folds the PR reference into the
  task description and the reviewer clones the SERVICE's linked repo, fetching the PR head by
  number from `origin`. So a `prUrl` pointing at a different repo than the service's is reviewed
  against the wrong `origin`. Resolving `prUrl` → owner/repo/number server-side and cloning that
  repo is a follow-up; until then the create form's target is effectively "a PR on this service's
  repo" (URL or `#number`).

## Per-slice status checklist

Statuses: `todo` / `in-progress` / `done`. Update (+ PR link) at the end of each PR.

### PR 1 — Review task type + reviewer agent (findings) — SHIPPED

PR 1 landed the **task type + pipeline + a working reviewer that produces prioritized
findings**, reusing the proven `registerAgentKind` container path (the `security-auditor`
pattern) rather than a bespoke inline engine controller. The reviewer is a built-in
`container-explore` `pr-reviewer` kind whose PROMPT does the slicing (it groups the changed
files into cohesive chunks and reviews one slice at a time, so Pi's agentic loop keeps each
slice's context bounded); its structured findings render read-only via `generic-structured`.
The **semantic LLM Slicer as its own stage, the human multi-select park loop, and the
fix/inline-comment resolutions moved to PR 2 / PR 3** (they need the park protocol + the
`prReview` step-state contracts + `createReview`, which are best introduced with their UI).

| #   | Item                                                                                                                                       | Status | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --- |
| 1   | Contracts: `review` in `taskTypeSchema`/`createTaskTypeSchema` + review `taskTypeFields` (`prNumber`/`prUrl`/`reviewFocus`)                | done   | 1   |
| 2   | `VcsClient`/`GitHubClient`.`listChangedFiles` + `FetchGitHubClient` impl + `FakeVcsClient` + adapter (GitLab omits it)                     | done   | 1   |
| 3   | `@cat-factory/agents`: built-in `pr-reviewer` kind (container-explore, structured findings, `generic-structured`)                          | done   | 1   |
| 4   | `pl_review` pipeline + `REVIEW_PIPELINE_ID` + `defaultPipelineIdForTaskType('review')`                                                     | done   | 1   |
| 5   | No-PR terminal path in `RunStateMachine.finalizeBlock` (read-only pipelines finish `done`, no PR-assuming card)                            | done   | 1   |
| 6   | `BoardService.addTask`: fold the PR reference + focus into a review task's description                                                     | done   | 1   |
| 7   | Frontend: `AddTaskModal` review chip + fields, `WorkspaceSettingsPanel` type key, i18n (all locales)                                       | done   | 1   |
| 8   | Unit tests: seed (pipeline + type default), agents registry (pr-reviewer), no-PR `finalizeBlock` terminal path, review description folding | done   | 1   |

`listChangedFiles` is landed ahead of its consumer — it is the data source for PR 2's
semantic Slicer (which reviews the manifest, not the whole diff).

### PR 2 — Human finding-selection UI (park loop) — SHIPPED

**Design decision (supersedes the original "inline Slicer" plan):** PR 2 keeps PR 1's
full-source **container `pr-reviewer`** as the review substrate rather than replacing it with
an inline manifest-Slicer + per-slice reviewer. The container agent already slices from the
cheap `--name-status`/`--stat` signals and reviews one slice at a time in Pi's agentic loop,
so it keeps per-slice context bounded **while retaining full-source access** (follow a call
site, read an unchanged neighbour, grep the repo) — which an inline patch-only reviewer can't.
The inline Slicer's only unique win (a provably-linear token ceiling) wasn't worth the review-
quality loss, so the "semantic LLM Slicer as its own stage" is dropped (may return as an opt-in
pre-slicer for pathological PRs). What PR 2 adds is the part that is substrate-independent: the
`step.prReview` state, the human multi-select **park loop**, the dedicated window, and the card.

PR 2 resolves with a neutral **`finish`** (record the curated selection + complete the read-only
review); the two real resolutions (Fixer / inline PR comments) stay PR 3 — neither is possible
without PR 3's `createReview` + fixer dispatch, so shipping placeholder buttons would be
half-wired. The window presents findings + multi-select + `Finish review`; PR 3 adds the two
action buttons that consume `selectedFindingIds`.

| #   | Item                                                                                                                                                                                                                                                               | Status | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --- |
| 9   | Contracts: `prReview.ts` (severity/category/slice/finding/step-state + `prReviewAgentOutputSchema` + `resolvePrReview`), `pipelineStepSchema.prReview`, `result-views.ts` `pr-review`, `notifications.ts` `pr_review_ready` (+ `sliceCount`), `routes/prReview.ts` | done   | 2   |
| 10  | Engine: `pr-review` completion interceptor records the reviewer's coerced findings onto `step.prReview` + parks (`PrReviewController` / `prReview.logic.ts`); `pr_review_ready` notification; `resolve` records the selection + advances past the gate             | done   | 2   |
| 11  | `stores/prReview.ts` + `PrReviewWindow.vue` (multi-select, severity/category badges, grouped by slice, `Finish review`)                                                                                                                                            | done   | 2   |
| 12  | Register result-view in `StepResultViewHost.vue`; `ui.openPrReview` opener; `NotificationsInbox` reveal branch; `pr-reviewer` archetype `resultView: 'pr-review'`                                                                                                  | done   | 2   |
| 13  | i18n `en.json` + all 9 locales (parity, real translations) for the window + the Slack route + inbox action                                                                                                                                                         | done   | 2   |
| 14  | `@cat-factory/server` `PrReviewController` (`GET`/`resolve`) + cross-runtime conformance (park → select → resolve)                                                                                                                                                 | done   | 2   |

`pendingPrReviewPost` (the post-as-comments driver marker) is deferred to PR 3 with the
resolution it serves — PR 2 has no consumer for it, so adding it now would be dead state.
The inline `listChangedFiles` (landed in PR 1 as the Slicer's data source) is currently
unused by the container path; PR 3 may consume it for the inline-comment anchor resolution, or
it stays available for a future opt-in pre-slicer.

### PR 3 — Resolutions

| #   | Item                                                                                                         | Status | PR  |
| --- | ------------------------------------------------------------------------------------------------------------ | ------ | --- |
| 12  | `VcsClient`/`GitHubClient`.`createReview` (inline comments) + impl + fake + GitLab-unsupported + conformance | todo   |     |
| 13  | Fix action: fold selected findings into `fixer` dispatch (phase-B re-dispatch of the same step)              | todo   |     |
| 14  | Post action: `pendingPrReviewPost` driver marker → `createReview` inline comments; finish step               | todo   |     |
| 15  | `NotificationService.clearWaitingDecision` includes `pr_review_ready`; conformance for both resolutions      | todo   |     |

## Closing out

When PRs 1–3 land, convert this tracker into a numbered ADR under `backend/docs/adr/`
(next free number after 0022) capturing Context / Decision / Rationale / Consequences, and
`git rm` this tracker in the same PR (per CLAUDE.md).

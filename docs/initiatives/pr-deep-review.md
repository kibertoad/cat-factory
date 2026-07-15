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

- **Inline-driver review (stages 1–3)** — the requirements-review reviewer runs its LLM work
  inline in the durable driver: `ReviewGateController`
  (`backend/packages/orchestration/src/modules/execution/ReviewGateController.ts`) +
  `requirements.logic.ts` (`buildReviewPrompt`, `coerceReviewItems` — severity-sort + cap,
  `disposeReview`). Item severity/category/status shapes:
  `backend/packages/contracts/src/requirements.ts`.
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
- **Token guardrails are the point.** The Slicer must never receive full patches; only per-slice
  reviewers do, one slice at a time, under a hard per-slice budget. Keep a mechanical fallback so
  an unwired/failed Slicer degrades to directory-grouped chunks rather than failing the run.
- **Pass-through when unwired.** No model / no GitHub client ⇒ the review step is a no-op that
  advances (exactly like requirements-review and the fork proposer). Conformance depends on this.
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

### PR 2 — Semantic Slicer + human selection UI

| #   | Item                                                                                                                                                                                                           | Status | PR  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 9   | Contracts: `prReview.ts` (findings/slices/step-state/choose), `pipelineStepSchema.prReview` + `pendingPrReviewPost`, `result-views.ts` `pr-review`, `notifications.ts` `pr_review_ready`, `routes/prReview.ts` | todo   |     |
| 10  | Inline semantic Slicer (reads the `listChangedFiles` manifest → cohesive slices; mechanical fallback) + per-slice review + aggregate onto `step.prReview`, park + notification                                 | todo   |     |
| 11  | `stores/prReview.ts` + `PrReviewWindow.vue` (multi-select, severity badges, grouped by slice, two footer actions)                                                                                              | todo   |     |
| 12  | Register result-view in `StepResultViewHost.vue`; `ui.openPrReview` opener; `NotificationsInbox` reveal branch; `catalog.ts` archetype `resultView`                                                            | todo   |     |
| 13  | i18n `en.json` + all locales (parity) for the window                                                                                                                                                           | todo   |     |

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

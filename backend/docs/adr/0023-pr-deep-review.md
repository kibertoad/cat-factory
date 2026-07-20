# ADR 0023: "Review" task type — scalable deep review of an open PR

- **Status:** Accepted (implemented)
- **Date:** 2026-07-15
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/server`, both runtime facades) + frontend (`@cat-factory/app`)

## Context

cat-factory had no first-class way to **deep-review an existing, already-open pull request** —
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
(follow a call site, read an unchanged neighbour). It returns `prReviewAgentOutputSchema` (slices

- severity-ordered findings) as `result.custom`.

The engine coerces that output (`coercePrReview` — mint ids, anchor findings to slices,
severity-sort) onto **`step.prReview`** and, via the `pr-review` completion interceptor, **parks**
the run for a human to multi-**select** which findings matter through the dedicated `pr-review`
result-view window. The human then resolves the parked review one of three ways
(`resolvePrReviewSchema.action`):

- **`finish`** — record the curated selection and advance past the gate (no side effect).
- **`fix`** — re-arm the same `pr-reviewer` step (mirroring the fork-decision phase-B re-dispatch)
  so the durable driver re-dispatches it as the **Fixer** (`FIXER_AGENT_KIND`, `container-coding`
  - `clone:{branch:'pr'}`): the engine resolves the reviewed PR's head branch (via the
    checkout-free `RepoFiles.pullRequestHeadRef`) and folds a synthetic `pullRequest` + an apriori
    WORKING branch into the dispatch context so the Fixer clones + pushes that branch, with the
    selected findings rendered into its prompt (`renderPrReviewFixerFeedback`). The Fixer's
    completion marks the review `done`.
- **`post`** — re-arm with an at-most-once `pendingPrReviewPost` marker so the driver publishes the
  selected findings as a single advisory (`COMMENT`) inline review via `RepoFiles.createReview`
  (`buildPrReviewPost` maps line-carrying findings to inline comments and folds line-less ones into
  the review body), then finishes the step.

All review state rides `step.prReview` — **no side table** — so it is runtime-symmetric by
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
  reconstruct-the-diff turns (see `docs/initiatives/pr-review-turn-reduction.md`) — an accelerant
  layered ON the full-clone container review, not the dropped patch-only inline design.
- **State-on-step + park/resolve mirror the fork-decision flow.** The `fix` resolution reuses the
  proven `choose`-style re-arm (`resetStepForRerun` + `startStep` + `signalDecision`), and `prReview`
  survives `resetStepForRerun` exactly like `forkDecision`. This kept the whole feature free of a
  new persisted table and automatically cross-runtime-symmetric.
- **Reuse `FIXER_AGENT_KIND` verbatim.** Because a `review` task carries no own work branch, the
  engine synthesises the PR head branch into the dispatch context (via an apriori working branch so
  the work-branch machinery targets it, probed not created — no orphan `cat-factory/<blockId>`
  branch), so the unchanged `container-coding` + `clone:{branch:'pr'}` fixer body clones and pushes
  the reviewed PR's branch.
- **At-most-once posting.** `post` runs in the durable driver (the `pendingPrReviewPost` marker is
  consumed — cleared + persisted — before the side-effecting `createReview`), so a Workflows
  retry/replay can't submit the review twice. Because the marker is consumed first, a retry will
  NOT re-post, so a `createReview` that actually throws (GitHub 422s the batched review — most
  commonly a finding anchored to a line outside the PR diff, which rejects the WHOLE review — or a
  transient network/5xx error) must NOT silently complete the step as `done` with nothing posted.
  `postPrReview` therefore fails the step LOUDLY on a post error (a `job_failed` surfaced on the
  board, mirroring the `fix` preflight failure) rather than reporting a misleading success; the
  human can re-run `post` or switch to `fix`/`finish`. To keep GitHub from rejecting the review for
  a blank body, `buildPrReviewPost` always emits a non-empty `body` (falling back to a count of the
  inline comments when neither a summary nor an unanchored finding supplies one).
- **Pass-through when unwired.** A clean PR (no findings) records an empty `done` review and lets
  the normal spine finish (no park); an unwired reviewer / no VCS write degrades gracefully. The
  cross-runtime conformance suite asserts the park → select → resolve loop for all three actions.

## Consequences

- A read-only pipeline (`pl_review`) finishes `done` with no PR-assuming card — the no-PR terminal
  path in `RunStateMachine.finalizeBlock` handles it.
- **The `reviewing` status is seeded at dispatch, not just on completion.** The engine seeds
  `step.prReview = { status: 'reviewing', prUrl, model, … }` (`initialPrReviewState`) the moment the
  reviewer's container job dispatches — the `recordFindings` interceptor already treated `reviewing`
  as "not yet recorded" and coerces over it — so the deep-review window renders a real in-flight
  phase instead of an empty panel. The reviewer's prompt maintains a per-slice todo list, which
  surfaces as the step's live `subtasks`; the window renders that as slices-reviewed / total during
  `reviewing`, so a running deep review shows its chunk progress rather than a bare "agent running".
- **Same-repo, non-fork PRs only.** The reviewer clones the service's linked repo and fetches the
  PR head by number, and the Fixer pushes to that head branch — so the `fix` resolution requires a
  PR on the service's own repo the platform can push to. A cross-repo `prUrl` (a PR on a different
  repo than the service's) and fork PRs are **deliberately not** resolved yet; the create form's
  target is effectively "a PR on this service's repo" (URL or `#number`), and `post` is the
  fallback when a PR can't be pushed to. Resolving `prUrl` → owner/repo/number server-side is a
  future follow-up.
- GitLab omits `getPullRequestHeadRef`/`createReview` (optional methods), so the `fix`/`post`
  resolutions report the operation unresolvable/unsupported on a GitLab deployment rather than
  acting on the wrong repo — consistent with `listChangedFiles`.

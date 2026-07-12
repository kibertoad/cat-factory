# ADR 0021: Apriori branches (pre-existing branches as run input)

- **Status:** Accepted (implemented)
- **Date:** 2026-07-10
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`, `@cat-factory/server`, `@cat-factory/orchestration`, `executor-harness`, both runtime facades) + frontend (`@cat-factory/app`)

## Context

Every agent run started from the repo **default branch** and worked in the deterministic
per-block branch `cat-factory/<blockId>` (`RepoTarget.baseBranch`,
`resolveRepoTarget.ts`). There was no way to hand a run pre-existing branches as input —
yet that is a common real-world shape: a human (or an earlier tool) has already pushed a
spike, a prototype, or a half-finished feature branch, and the task's agents should
either learn from it or continue it.

## Decision

A task (`Block`) can name existing branches of its **primary target repo**, each in one
of two deliberately-disjoint modes, persisted as one optional JSON field
`aprioriBranches: Array<{ name, mode }>` mirroring `referenceRepos`:

- **`reference`** — read-only context (a spike / prototype / prior-art branch). Consuming
  agents may read it (log/diff/open files) but NEVER commit to or push it.
- **`working`** — the branch the run keeps building inside: it starts from and continues
  committing into this branch instead of minting `cat-factory/<blockId>`, and the PR / CI
  gate / merger all ride it. At most ONE working entry per task.

The two modes are mechanically distinct:

- **Working mode is the existing resume path.** The harness already resumes any remote
  branch named as `spec.newBranch`, so the whole mode is a backend-side branch-name swap:
  `workBranch = aprioriWorkingBranch(context) ?? cat-factory/${blockId}`, applied in the
  THREE places that hardcode the work-branch name (`ContainerAgentExecutor.buildJobBody`,
  `RunDispatcher.resolveRepoOpBranch`, and the spec-writer arm `builtInRepoOpBranch`). The
  branch must pre-exist — dispatch **probes, never creates**, and fails loudly on a miss.
- **Reference mode rides the primary checkout, not a `referenceRepos` leg.** The harness
  gains one optional `referenceBranches?: string[]` job field and, after checkout, fetches
  each as `origin/<b>` under `authEnv` (the clone is shallow single-branch and the agent
  has no git credentials, so the harness is the only place that can fetch). The backend
  renders a prompt section (readable as `origin/<b>`, never committed to). Consumer kinds:
  `coder`, `spec-writer`, `doc-writer`, and the read-only design/analysis kinds — NOT the
  PR-cloning fix/assess kinds.

Cross-entry invariants are enforced at the write boundary (`BoardService.updateBlock` →
`aprioriBranchesError`) and mirrored in the UI (`TaskAprioriBranches.vue` in
`TaskRunSettings.vue`) as disabled controls rather than rejected writes: single working
entry, no duplicate names, working frozen once a PR exists, no working entry on a
multi-repo task.

## Rationale

- **One JSON field, not two scalars.** One list in the UI, one write-boundary validation
  site, and it extends cleanly (a future per-entry `repo` for cross-repo references).
- **Reference branches ride the primary checkout, not sibling `referenceRepos` legs.**
  Same-repo sibling legs are structurally impossible: the harness sibling dir is a
  deterministic `owner__name` with no collision handling, so a same-repo leg collides with
  the primary checkout. Forcing multi-repo mode would also drop checkpoint pushes,
  persistent checkouts, and follow-up streaming. Fetching `origin/<b>` refs avoids all of it.
- **Missing-branch handling is mode-asymmetric by design.** A missing _working_ branch
  fails the dispatch loudly (it is the starting point); a missing _reference_ branch is
  dropped with a logged warning (it is garnish).
- **A merged apriori working branch is never deleted** — only `cat-factory/*` branches are
  torn down post-merge. A user's branch is theirs. Consequence: a new task reusing a merged
  apriori branch RESUMES it (the new PR's diff contains only the new commits) — intended.
- **Protected branch as working: UI warning only.** A rejected push is a normal harness
  failure; no dispatch-time hard block.
- **Working frozen once a PR exists.** The recorded `pullRequest.branch` already pins the
  run's branch everywhere; allowing an edit after that would silently diverge.

## Consequences

- **Reference mode is image-affecting.** The `executor-harness/src` fetch change bumped the
  harness version + the three image-tag pins (`pnpm sync:image-tags`); the released tag only
  serves new containers after `pnpm image:publish` + `pnpm deploy`.
- **Prompt guidance uses two-dot diffs** (`git diff origin/<b>`), not three-dot: the primary
  clone is shallow, so `...` has no merge base.
- **Cross-runtime symmetry** held throughout: the new column landed as a D1 migration ⇄
  Drizzle schema + generated migration via the shared `blockFields` mapper entry, with a
  conformance round-trip and an agent-context-substitution assertion against both stores.
- **Deliberately not pursued (would be their own small follow-ups):**
  - **Working mode on multi-repo tasks** (`involvedServiceIds`) — peer legs mint
    `newBranch: workBranch` in every involved repo, and minting a user's branch name across
    peer repos is wrong. Rejected at the write boundary in v1; lifting it means splitting
    `parts.workBranch` into primary/peer values.
  - **Cross-repo reference branches** — an optional user-picked `branch` on
    `referenceRepoSchema`. Nearly free for OTHER repos (the harness already clones a
    reference leg at whatever `baseBranch` the spec carries), but the same-repo case is the
    primary use case and uses the different mechanism above.
  - **Commit/tag/SHA pinning** — only branch heads; a pinned-ref variant would be a new
    mode, not an overload of these two.

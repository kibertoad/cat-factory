---
'@cat-factory/orchestration': minor
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/conformance': patch
---

Apriori branches (slice 2): working mode.

A task's single optional `working` apriori branch now drives the run — the agents start from
and keep committing into that pre-existing branch instead of minting `cat-factory/<blockId>`,
and the PR opens from it, the CI gate polls it, and the merger merges it. See
`docs/initiatives/apriori-branches.md`.

- **Context**: the engine lifts the block's `aprioriBranches` verbatim onto the agent run
  context (`AgentRunContext.aprioriBranches`), a pure projection like `referenceRepos`.
- **Work-branch swap**: `ContainerAgentExecutor.buildJobBody` and the two `RunDispatcher`
  repo-op sites (`resolveRepoOpBranch` + the spec-writer `builtInRepoOpBranch`) resolve the
  work branch as `resolveAprioriWorkingBranch(...) ?? cat-factory/<blockId>`, so every
  downstream builder (`newBranch` / `pushBranch` / explore fallback / PR head) rides the
  user's branch. The base-branch rejection is a single shared `resolveAprioriWorkingBranch`
  helper (`@cat-factory/contracts`) so the executor and dispatcher rejections can't drift.
- **Probe, never create**: an apriori working branch must already exist — it is probed
  (`ensureWorkBranch(..., { create: false })`, or a checkout-free `headSha`), and a missing
  branch fails the dispatch loudly rather than being silently created off base. A working
  branch equal to the repo base is rejected.
- **Merge teardown guard**: `GitHubPullRequestMerger` only deletes a merged head branch when
  it is a platform `cat-factory/*` branch — a user-provided apriori branch is never torn down
  (reusing a merged apriori branch on a later task intentionally resumes it).
- **Conformance**: a cross-runtime assertion that a custom kind's post-op commits onto the
  task's apriori working branch instead of `cat-factory/<blockId>` on both stores.

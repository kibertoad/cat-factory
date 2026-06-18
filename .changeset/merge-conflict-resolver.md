---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/executor-harness': patch
---

Add an automated merge-conflict resolver, and converge the container coding agents
onto a shared base.

**Conflict resolver.** Previously a PR that conflicted with its base degraded to a
manual `merge_review` handoff. A new pre-merge `conflicts` gate now sits before the
`ci`/`merger` steps in the standard pipelines (mirroring the CI gate): it reads the
PR's mergeability (`PullRequestMergeabilityProvider` → GitHub `mergeable_state`) and,
on a real conflict, dispatches a `conflict-resolver` container agent that clones the
PR branch, merges the base in, has the agent resolve the conflicts, and pushes back
onto the same branch — looping (bounded by the merge preset's attempt budget) until
the PR is mergeable, or failing the run for a human if it can't. Pass-through when no
mergeability provider is wired (e.g. tests / no GitHub), so existing behaviour is
unchanged. The resolver never pushes a half-resolved tree (it guards on remaining
unmerged paths).

**Shared base.** The container agents were near-duplicates of one clone → write
context → run Pi → push flow. They now share `runCodingAgent` (implement + ci-fix +
conflict-resolve) on top of a thinner `withWorkspace` / `runAgentInWorkspace` base
(also used by bootstrap / blueprint / merger), plus shared no-op-reason helpers — so
fixes like the "judge the whole run, counting the agent's own commits" change apply
everywhere instead of being re-derived per agent.

Bumps `@cat-factory/executor-harness` (new `/resolve-conflicts` endpoint + shared-base
refactor change its image).

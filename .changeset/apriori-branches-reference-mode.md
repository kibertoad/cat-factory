---
'@cat-factory/executor-harness': minor
'@cat-factory/server': patch
---

Apriori branches (slice 3): reference mode.

A task can now attach pre-existing branches of its PRIMARY repo as READ-ONLY reference points
(a spike / prototype / prior-art branch) that the consumer agents may inspect but never commit
to. See `docs/initiatives/apriori-branches.md`.

- **Harness** (image bump): the `agent` job gains an optional `referenceBranches?: string[]`.
  After the primary checkout each named branch is fetched into its `origin/<b>` tracking ref
  (`git fetch --no-tags origin +refs/heads/<b>:refs/remotes/origin/<b>`), best-effort per
  branch (a vanished branch is warned + skipped, never fatal) — the only place with git
  network credentials, since the primary clone is shallow single-branch and the agent has none.
  Wired into the single-repo coding + explore flows and the multi-repo primary legs.
- **Backend**: `ContainerAgentExecutor` lifts the task's `reference` apriori branches for the
  consumer kinds (`coder` / `spec-writer` / `doc-writer` / `architect` / `analysis`), PROBES
  each at dispatch and DROPS a missing one (asymmetric with a missing WORKING branch, which
  fails loudly), and renders a "Reference branches" system-prompt section (read via
  `git log origin/<b>`, two-dot `git diff origin/<b>`, `git show origin/<b>:<path>`, or a
  `git worktree`) that forbids committing to or pushing them. The section + `referenceBranches`
  ride both the coding and explore job bodies.

---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
---

Service connections Phase 4 (= bug-triage Phase C) — multi-PR gates + merge-all. The `ci`,
`conflicts` and `merger` tail now operate across ALL of a multi-repo task's pull requests
(own-service + peer-service repos from Phase 3), not just the own PR — no runner-image change
(the ci-fixer reuses the existing sibling-checkout harness path via a widened `peerRepos` job
body).

- **CI gate** aggregates check runs across every PR: a red check in ANY repo fails the gate,
  the failing repo(s) are named, and `step.gate.headShas` tracks each PR head. The `ci-fixer`
  helper now fans out across the sibling checkouts (the `coder`-only multi-repo dispatch is
  widened to `ci-fixer`) so one fixer round covers every failing repo. `CiStatusReport` becomes
  per-PR (`repos: RepoCiStatus[]`).
- **Conflicts gate** probes mergeability per PR (`MergeabilityReport.repos`); any PR still
  computing keeps polling, the first conflicted repo is recorded on `step.gate.conflictTarget`.
  The conflict-resolver stays single-repo.
- **Merger** merges every PR in provider-before-consumer order (`orderPrsForMerge`), stopping at
  the first failure. The task is `done` only when ALL PRs merged; a mid-sequence failure
  (cross-repo merges are non-atomic) leaves the block `blocked` and raises an enumerated
  `merge_review` notification (`payload.mergedRepos` / `unmergedRepos`, decision reason
  `merge_partial`). `PullRequestMerger.mergeForBlock` becomes `mergePullRequests(prs)` returning
  a `MergeAllOutcome`.
- Cross-runtime conformance asserts multi-repo CI aggregation + escalation on both runtimes;
  the merge-all ordering + provider fan-out are unit-tested.

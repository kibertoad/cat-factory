---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Fix opaque "Failed to open PR (HTTP 422): No commits between ..." run failure when a
coding run resumes a work branch that has nothing ahead of its base (e.g. its earlier PR
was merged with a merge commit, leaving the branch reachable from base and its best-effort
delete skipped).

- `runCodingAgent` no longer treats a resumed branch as work unconditionally: when the
  branch has no new commits this pass, it confirms the branch is actually ahead of the PR
  base (new `branchAheadOfBase`, tri-state so an undeterminable result keeps the prior
  resume-is-work behaviour) and records a clean no-op otherwise.
- `openPullRequest` now maps GitHub's `422 "No commits between ..."` to a no-op (returns
  `null`) instead of a hard `HarnessFailure`, as a backstop.

Image-bumping: `@cat-factory/executor-harness` → 1.31.7 with the three runner-image pins
synced.

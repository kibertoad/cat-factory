---
'@cat-factory/server': patch
---

`GitHubPullRequestMerger` now logs (at warn) when the best-effort delete of a merged work
branch fails, instead of swallowing it silently. A skipped delete is what strands a
resumable-but-empty branch that a later re-dispatch then fails to open a PR for — so making
it observable is the diagnostic hook for that class of stuck run.

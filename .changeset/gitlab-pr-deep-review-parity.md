---
'@cat-factory/gitlab': minor
'@cat-factory/local-server': patch
---

Close the PR-deep-review parity gap on GitLab: `FetchGitLabClient` now implements
`listChangedFiles`, `getPullRequestHeadRef`, `getPullRequestHeadSha` and `createReview`. All four
are optional on the `VcsClient` port and every consumer degrades silently without them, so a
GitLab deployment previously ran the review flow to completion while the merge track record
classified every run `unknown` (never matching a per-class merge rule) and the selected findings
never reached the merge request. Cross-provider conformance now asserts their presence.

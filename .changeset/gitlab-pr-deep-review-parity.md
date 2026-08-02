---
'@cat-factory/gitlab': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
---

Close the PR-deep-review parity gap on GitLab: `FetchGitLabClient` now implements
`listChangedFiles`, `getPullRequestHeadRef`, `getPullRequestHeadSha` and `createReview`. All four
are optional on the `VcsClient` port and every consumer degrades silently without them, so a
GitLab deployment previously ran the review flow to completion while the merge track record
classified every run `unknown` (never matching a per-class merge rule) and the selected findings
never reached the merge request. Cross-provider conformance now asserts their presence.

Two breaking shapes ride along, both because a provider that cannot answer must say so rather than
answer zero:

- **`GitHubChangedFile.additions` / `deletions` are now `number | null`.** Null means the host did
  not report a count — GitLab withholds the hunk the counts are derived from for an oversized diff,
  and these render straight into the reviewer's prompt, where `+0/-0` describes a file nobody
  touched. GitHub still reports a real `0` for a binary it cannot line-count, and the conformance
  suite pins both. A consumer folding null to `0` must now do so deliberately. GitHub's own mapper
  moves to `githubProjection.toChangedFileProjection` (`@cat-factory/integrations`) so the decision
  sits beside its GitLab counterpart rather than inline in the fetch client.
- **`logger` is REQUIRED on the GitLab facade builders** (`buildGitLabEngineClient`,
  `buildGitLabConnectClient`, `registerGitLab`) and is kernel's `Logger` rather than a bespoke
  `{ warn }`. It was optional, and consequently no composition root passed one — leaving the page-cap
  truncation warning unreachable in production, on the very reads a review is sliced from. The local
  facade now builds its client through the shared `buildGitLabEngineClient` instead of assembling the
  same pair by hand, so it cannot miss the next thing that builder gains.

---
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': patch
'@cat-factory/agents': patch
---

PR deep-review `post`: guard against comment position drift when the PR branch is updated
after a review starts. The reviewer's dispatch now captures the PR head sha
(`reviewedHeadSha`), and the `post` resolution re-reads the current head before publishing:
if the branch moved, every finding is folded into the summary comment instead of being
anchored to a line number that may have shifted, so comments can't land on the wrong code.
Adds an optional `pullRequestHeadSha` read to the `GitHubClient`/`VcsClient`/`RepoFiles`
ports (best-effort; the check is inert where a provider can't read it).

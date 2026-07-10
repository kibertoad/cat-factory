---
'@cat-factory/server': patch
---

Perf: cut redundant GitHub reads on the gate-poll path (performance-optimizations item 2).

- `FetchGitHubClient` memoizes a repo's numeric id per `(installationId, owner, repo)` in a
  process-level map (the mapping is immutable, same justified pattern as `ownerAppCache`), so
  the `/repos/{owner}/{repo}` backfill behind `listBranches`/`listIssues`/`listCommits`/
  `listCheckRuns` runs once instead of on every call.
- `GitHubCiStatusProvider` resolves a PR head via one exact `branchHeadSha` ref lookup instead
  of paging the branch's commit list just to read `items[0]`.
- `PatPreferringAppRegistry` resolves the run initiator's PAT once per `runWithInitiator`
  scope (one gate probe / merge boundary) via a per-scope memo, instead of a fresh DB read +
  decrypt on every GitHub `request()` the probe fans out.

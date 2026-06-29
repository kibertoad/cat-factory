---
'@cat-factory/gitlab': minor
'@cat-factory/kernel': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/conformance': patch
---

Close the GitLab-vs-GitHub provider parity gaps so a GitLab deployment behaves like a GitHub
one across every runtime facade.

- **Facade parity (the showstopper):** the engine's CI / mergeability / PR-review gate
  providers, the PR merger, the branch updater and the checkout-free `RepoFiles` resolvers are
  now wired from a GitLab-backed client on the **Node and Cloudflare** facades too — previously
  only local mode bridged GitLab into the gates, so a stock GitLab-only Node/CF deployment did
  not gate on real CI or merge for real. Both facades now build the engine VCS client via the
  shared `buildGitLabEngineClient` (GitHub App wins when both are configured).
- **Review provider:** `FetchGitLabClient` now implements the human-review reads
  (`getPullRequestBaseRef`, `listRequestedReviewers`, `listPullRequestReviews` +
  `getRequiredApprovingReviewCount` from GitLab approvals, `listReviewThreads` /
  `replyToReviewThread` / `resolveReviewThread` over resolvable MR discussions, plus
  `listIssueComments`).
- **Branch update:** new optional `VcsClient.rebasePullRequest` / `GitHubClient.rebasePullRequest`
  — GitLab has no server-side merge-branch-into-branch endpoint, so the conflicts / human-testing
  gate's "pull latest base" action advances a GitLab MR branch by rebasing it; `GitHubBranchUpdater`
  prefers rebase when the client exposes it and falls back to `mergeBranch` (GitHub) otherwise.
- **Conformance:** the cross-provider VCS client suite now asserts GitHub and GitLab normalise the
  human-review gate inputs identically and exposes the correct branch-advancing capability per
  provider; a reusable `FakeVcsClient` drives the real gate / merge / branch-update providers
  through the GitLab-backed adapter.

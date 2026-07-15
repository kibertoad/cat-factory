---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/app': minor
---

PR deep-review: resolve a parked review by fixing or posting the selected findings.

The `pr-review` window now offers two terminal resolutions alongside `Finish`, both acting on
the human's curated finding selection:

- **Fix** re-dispatches the `pr-reviewer` step as a Fixer (`FIXER_AGENT_KIND`) that clones the
  reviewed PR's head branch, commits fixes addressing the selected findings, and pushes back onto
  it (no new PR).
- **Post** publishes the selected findings as a single advisory (`COMMENT`) inline PR review — each
  line-anchored finding as an inline comment, the rest folded into the review body.

Two new optional VCS reads/writes back these resolutions — `getPullRequestHeadRef` and
`createReview` on the neutral `VcsClient` + `GitHubClient` ports (GitHub-implemented, omitted on
GitLab), surfaced to the engine through the checkout-free `RepoFiles` seam. All review state stays
on `step.prReview` (no side table); a cross-runtime conformance assertion covers both resolutions.

Scoped to a same-repo, non-fork PR (the reviewer's existing limitation); a cross-repo `prUrl` and
fork PRs remain a tracked follow-up. See `backend/docs/adr/0023-pr-deep-review.md`.

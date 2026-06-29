---
'@cat-factory/local-server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/gitlab': minor
---

Meaningfully widen GitLab support in local mode — a `GITLAB_PAT` deployment now drives the
real agent workflow, not just sign-in:

- **`@cat-factory/gitlab`** adds `asGitHubClient(...)`, a `VcsClient`→`GitHubClient` adapter so
  any provider-neutral VCS client (e.g. `FetchGitLabClient`) satisfies the legacy `GitHubClient`
  port the engine's CI gate, merger and repo-read paths still consume.
- **`@cat-factory/local-server`** wires a GitLab PAT symmetrically to the GitHub PAT: the agent
  containers' git clone/push token falls back to `GITLAB_PAT`, and the CI gate, mergeability,
  real merge and repo-link flows read through a PAT-backed `FetchGitLabClient` (adapted to
  `GitHubClient`). A GitLab-only local deployment is now a first-class source-control backend.
  Set `GITLAB_API_BASE` for a self-managed instance. The boot warning and the cross-provider
  `vcs-conformance` test cover both providers.
- **`@cat-factory/executor-harness`** opens a GitLab **merge request** (not a GitHub PR) when the
  repo's clone URL points at a GitLab host — the REST base + project path are derived from the
  host, and an already-open MR is reused on a resumed run. The GitHub path is unchanged. (The
  runner image must be republished for this to take effect in a deployed worker.)

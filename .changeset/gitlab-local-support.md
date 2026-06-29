---
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
'@cat-factory/server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/gitlab': minor
---

Meaningfully widen GitLab support in local mode — a `GITLAB_PAT` deployment now drives the
real agent workflow, not just sign-in:

- **`@cat-factory/gitlab`** adds `asGitHubClient(...)`, a `VcsClient`→`GitHubClient` adapter so
  any provider-neutral VCS client (e.g. `FetchGitLabClient`) satisfies the legacy `GitHubClient`
  port the engine's CI gate, merger and repo-read paths still consume.
- **`@cat-factory/server`** resolves a run's repo origin (clone URL + provider) through an
  injectable `resolveRepoOrigin` seam and stamps the provider onto the dispatched job, instead
  of hardcoding a `github.com` clone URL. The default stays GitHub, so the Worker/Node facades
  are unchanged; a GitLab deployment supplies a GitLab origin so containers clone the right host
  and open merge requests. Without this the clone URL was always github.com, so a GitLab repo
  could never be cloned by an agent container.
- **`@cat-factory/node-server`** threads `resolveRepoOrigin` through `NodeContainerOptions` to
  the container executor (default GitHub), so a sibling facade can supply a GitLab origin.
- **`@cat-factory/local-server`** wires a GitLab PAT symmetrically to the GitHub PAT: the agent
  containers' git clone/push token falls back to `GITLAB_PAT`; the CI gate, mergeability, real
  merge and repo-link flows read through a PAT-backed `FetchGitLabClient` (adapted to
  `GitHubClient`); the agent containers clone the configured GitLab host + open merge requests
  (via `resolveRepoOrigin`); and the GitLab host is added to the harness clone/push allow-list
  (`GITHUB_ALLOWED_HOSTS`) so the container doesn't reject the GitLab clone URL. A GitLab-only
  local deployment is now a first-class source-control backend. Set `GITLAB_API_BASE` for a
  self-managed instance. The boot warning and the cross-provider `vcs-conformance` test cover
  both providers.
- **`@cat-factory/executor-harness`** opens a GitLab **merge request** (not a GitHub PR) when the
  job's `repo.provider` is `gitlab` (set authoritatively by the server, so a self-managed GitLab
  on an arbitrarily-named host is routed correctly), falling back to host inference from the
  clone URL. The REST base + project path are derived from the host, and an already-open MR is
  reused on a resumed run. The GitHub path is unchanged. (The runner image must be republished
  for this to take effect in a deployed worker.)

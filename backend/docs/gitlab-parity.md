# GitLab → GitHub parity

The repo ships a provider-neutral VCS layer (the `VcsClient` port, the `vcs-registry`, and
the `asGitHubClient` adapter that bridges any `VcsClient` to the legacy `GitHubClient` port
the engine's gates/merger still consume). GitHub is the reference implementation
(`@cat-factory/server`); GitLab lives in `@cat-factory/gitlab`.

This doc tracks the work that brings the GitLab provider to behavioural parity with GitHub
across all three runtime facades (Cloudflare Worker, Node, local), and the conformance
coverage that keeps them from drifting.

## Status

| #   | Work item                                                                                                                                                                                                                                                                                          | Area                                                                | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| 0   | This tracking doc                                                                                                                                                                                                                                                                                  | docs                                                                | done   |
| 1   | Wire GitLab into the **Node + Cloudflare** gate/merge/sync paths (a GitLab-only deployment must gate on real CI and merge for real, not only in local mode)                                                                                                                                        | `runtimes/node`, `runtimes/cloudflare`                              | done   |
| 2   | Implement the review-provider `VcsClient` methods on `FetchGitLabClient` (base ref, requested reviewers, approvals → reviews + required count, resolvable discussions → threads + resolve/reply)                                                                                                   | `@cat-factory/gitlab`                                               | done   |
| 3   | GitLab branch-update via MR **rebase** (`mergeBranch` has no GitLab analog)                                                                                                                                                                                                                        | `@cat-factory/kernel`, `@cat-factory/gitlab`, `@cat-factory/server` | done   |
| 4   | Cross-provider VCS conformance: the parameterized GitHub-vs-GitLab client suite extended over the human-review gate inputs + the rebase-capability asymmetry, plus a reusable `FakeVcsClient` that drives the real CI / review / branch-update / merge providers through the GitLab-backed adapter | `@cat-factory/conformance`, `runtimes/local`                        | done   |

## Known accepted gaps (intentional, not closed)

- **Code search** (`FetchGitLabClient.searchCode`) returns no results: GitLab blob search
  needs the instance's Advanced Search (Elasticsearch) and the basic API does not return a
  usable `owner/repo/url` per hit. The neutral doc-search box degrades to "no results".
- **Sub-issues** (`listSubIssues`): GitLab has no parent→child issue hierarchy, so the
  optional method is left unimplemented (the caller degrades gracefully).
- **Multi-connection / App-style connect flow**: GitLab uses the single-token model (one
  `GITLAB_TOKEN`/`GITLAB_PAT` per deployment), mirroring local mode's PAT. A per-workspace
  OAuth connect flow with many GitLab connections is future work, not part of this pass.
- **Listing page cap**: `FetchGitLabClient` paginates up to `MAX_PAGES` (~1000 items) and
  `logger.warn`s when truncating — surfaced, not silent.

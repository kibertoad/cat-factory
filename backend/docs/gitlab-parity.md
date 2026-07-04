# GitLab → GitHub parity

The repo ships a provider-neutral VCS layer (the `VcsClient` port, the `vcs-registry`, and
the `asGitHubClient` adapter that bridges any `VcsClient` to the legacy `GitHubClient` port
the engine's gates/merger still consume). GitHub is the reference implementation
(`@cat-factory/server`); GitLab lives in `@cat-factory/gitlab`.

This doc tracks the work that brings the GitLab provider to behavioural parity with GitHub
across all three runtime facades (Cloudflare Worker, Node, local), and the conformance
coverage that keeps them from drifting. For a deployer-facing, feature-by-feature
comparison (not a work log), see [`vcs-providers.md`](./vcs-providers.md).

## Status

| #   | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Area                                                                | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| 0   | This tracking doc                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | docs                                                                | done   |
| 1   | Wire GitLab into the **Node + Cloudflare** gate/merge/sync paths (a GitLab-only deployment must gate on real CI and merge for real, not only in local mode)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `runtimes/node`, `runtimes/cloudflare`                              | done   |
| 2   | Implement the review-provider `VcsClient` methods on `FetchGitLabClient` (base ref, requested reviewers, approvals → reviews + required count, resolvable discussions → threads + resolve/reply)                                                                                                                                                                                                                                                                                                                                                                                                                                  | `@cat-factory/gitlab`                                               | done   |
| 3   | GitLab branch-update via MR **rebase** (`mergeBranch` has no GitLab analog)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `@cat-factory/kernel`, `@cat-factory/gitlab`, `@cat-factory/server` | done   |
| 4   | Cross-provider VCS conformance: the parameterized GitHub-vs-GitLab client suite extended over the human-review gate inputs + the rebase-capability asymmetry, plus a reusable `FakeVcsClient` that drives the real CI / review / branch-update / merge providers through the GitLab-backed adapter                                                                                                                                                                                                                                                                                                                                | `@cat-factory/conformance`, `runtimes/local`                        | done   |
| 5   | Hosted GitLab **sign-in** parity: both hosted facades (Node + Cloudflare) wire the PAT-login identity registry (`vcsIdentity`: GitHub always, GitLab when a connection is configured — i.e. `GITLAB_TOKEN` is set, coupling GitLab sign-in to the engine connection, unlike GitHub whose PAT sign-in is unconditional), so a GitLab user can sign in to a hosted deployment by pasting their own PAT — held to the same login/org/domain allowlist as the GitHub OAuth path. Previously the Cloudflare Worker wired none, leaving it OAuth-only / GitHub-only for sign-in even though its engine already gated & merged on GitLab | `runtimes/node`, `runtimes/cloudflare`, `@cat-factory/server`       | done   |
| 6   | GitLab as a **primary auth identity** under the org allowlist: `GitLabIdentityResolver.resolveOrgs` enumerates the user's GitLab **group** memberships (`GET /groups?min_access_level=10`, lowercased full paths), so a hosted deployment that admits users by group membership (`AUTH_ALLOWED_ORGS`) can now admit a GitLab user. Previously only `GitHubIdentityResolver` implemented `resolveOrgs`, so `isPatIdentityAllowed`'s org branch was skipped for GitLab — a GitLab account could be a primary identity only via `AUTH_ALLOWED_LOGINS` / `AUTH_ALLOWED_EMAIL_DOMAINS`, never group membership                         | `@cat-factory/gitlab`                                               | done   |

## Known accepted gaps (intentional, not closed)

- **Code search** (`FetchGitLabClient.searchCode`) returns no results: GitLab blob search
  needs the instance's Advanced Search (Elasticsearch) and the basic API does not return a
  usable `owner/repo/url` per hit. The neutral doc-search box degrades to "no results".
- **Sub-issues** (`listSubIssues`): GitLab has no parent→child issue hierarchy, so the
  optional method is left unimplemented (the caller degrades gracefully).
- **Multi-connection / App-style connect flow**: GitLab uses the single-token model (one
  `GITLAB_TOKEN`/`GITLAB_PAT` per deployment) for the ENGINE's gate/merge/sync, mirroring local
  mode's PAT. A per-workspace OAuth connect flow with many GitLab connections is future work, not
  part of this pass. (User **sign-in** is separate and already at parity — a GitLab user pastes
  their own PAT at `/auth/pat` on any facade; see items 5–6. Admission via any of the three gates
  works — `AUTH_ALLOWED_LOGINS`, `AUTH_ALLOWED_EMAIL_DOMAINS`, and `AUTH_ALLOWED_ORGS` (matched
  against GitLab **group** full paths). There is no GitLab OAuth browser flow, so hosted GitLab
  sign-in is PAT-only, whereas GitHub additionally offers OAuth.)
- **Listing page cap**: `FetchGitLabClient` paginates up to `MAX_PAGES` (~1000 items) and
  `logger.warn`s when truncating — surfaced, not silent. The PAT-login group/org enumeration
  (`GitLabIdentityResolver.resolveOrgs` / `GitHubIdentityResolver.resolveOrgs`) follows the same
  `Link: rel="next"` pagination up to the same ~1000-entry cap, and likewise `logger.warn`s on
  truncation, so admission is not silently denied to a user whose allowlisted group/org sits on a
  later page.

# VCS providers: GitHub vs GitLab

cat-factory acts on real code through a provider-neutral VCS layer (the `VcsClient`
port + the `vcs-registry`), so a workspace's repos can live on **GitHub** or
**GitLab**. GitHub (`@cat-factory/server`) is the reference implementation every
engine path (gates, requirements review, execution, merge) is built against;
GitLab (`@cat-factory/gitlab`) is an opt-in provider implementing the same ports.
This page is for anyone **choosing a provider or running both** — it summarizes
what each one can actually do today. For implementation depth see
[`github-integration.md`](./github-integration.md) /
[`github-operations.md`](./github-operations.md) (GitHub) and
[`gitlab-parity.md`](./gitlab-parity.md) (the GitLab parity work log + conformance
coverage + the authoritative list of accepted gaps).

## Feature parity

| Capability                                                 | GitHub                                                                             | GitLab                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Credential model                                           | **App** installation — one credential scope per workspace                          | Single shared **token** (group/personal/OAuth PAT) per deployment                                                       |
| Multi-tenant credential isolation                          | ✅ per-installation token                                                          | ⚠️ one token for the whole deployment (mirrors local mode's PAT model)                                                  |
| Self-managed / on-prem instance                            | ✅ (GitHub Enterprise Server, via a configurable API base)                         | ✅ (`GITLAB_API_BASE`, any self-managed instance)                                                                       |
| Repo / branch reads                                        | ✅                                                                                 | ✅                                                                                                                      |
| File / directory reads                                     | ✅                                                                                 | ✅                                                                                                                      |
| Branch, commit, PR/MR create + write                       | ✅                                                                                 | ✅                                                                                                                      |
| PR/MR merge                                                | ✅                                                                                 | ✅                                                                                                                      |
| Update a PR/MR branch with its target                      | ✅ server-side branch merge (`mergeBranch`)                                        | ✅ via MR **rebase** (`rebasePullRequest`) — GitLab has no branch-merge endpoint                                        |
| CI status (checks / pipelines)                             | ✅ Checks API                                                                      | ✅ Pipelines                                                                                                            |
| Requested reviewers / submitted reviews                    | ✅                                                                                 | ✅ (approvals mapped to reviews)                                                                                        |
| Required approval count                                    | ✅ branch protection                                                               | ✅ MR approval rule                                                                                                     |
| Review threads (resolve / reply)                           | ✅                                                                                 | ✅ resolvable discussions                                                                                               |
| Issues: read / create / close / comment                    | ✅                                                                                 | ✅                                                                                                                      |
| Issue search                                               | ✅                                                                                 | ✅                                                                                                                      |
| Sub-issues (parent → child)                                | ✅                                                                                 | ❌ no native concept — method omitted, caller degrades gracefully                                                       |
| Code search                                                | ✅                                                                                 | ❌ returns no results — needs Advanced Search (Elasticsearch); basic API can't supply a usable `owner/repo/url` per hit |
| Webhooks: PR/MR, issue, push, CI status                    | ✅ HMAC-signed (`X-Hub-Signature-256`)                                             | ✅ token-header verified (`X-Gitlab-Token`)                                                                             |
| Webhooks: install/connection lifecycle (removed/suspended) | ✅ (`installation` / `installation_repositories`)                                  | ❌ not mapped — a removed/suspended connection isn't pushed live                                                        |
| Periodic reconciliation (catches missed webhooks)          | ✅                                                                                 | ✅ (same cron path, provider-neutral)                                                                                   |
| Repo provisioning (create in org/group)                    | ✅ two-app tier: a separate privileged App, permissions introspected before create | ✅ single token, optimistic — capability discovered by attempting the create (403 on denial)                            |
| User sign-in via pasted PAT                                | ✅                                                                                 | ✅                                                                                                                      |
| User sign-in via OAuth browser flow                        | ✅                                                                                 | ❌ PAT-only, no OAuth flow                                                                                              |
| Sign-in allowlist by login / email domain                  | ✅                                                                                 | ✅                                                                                                                      |
| Sign-in allowlist by org / group membership                | ✅ (`AUTH_ALLOWED_ORGS` against orgs)                                              | ✅ (`AUTH_ALLOWED_ORGS` against group full paths)                                                                       |
| Listing pagination cap                                     | ~1000 items, warns on truncation                                                   | ~1000 items, warns on truncation                                                                                        |

## Setup

- **GitHub** — register a GitHub App; see [`github-integration.md`](./github-integration.md)
  for the architecture and [`github-operations.md`](./github-operations.md) for the
  step-by-step setup.
- **GitLab** — opt-in, off by default. Set `GITLAB_TOKEN` (enables the provider) and
  optionally `GITLAB_API_BASE` (self-managed instance, defaults to `gitlab.com`),
  `GITLAB_CONNECTION_ID`, and `GITLAB_WEBHOOK_SECRET` for webhook delivery. Both hosted
  facades (Node, Cloudflare Worker) and local mode wire it the same way.

Both providers can be configured on the same deployment at once — a workspace's repos
just need to resolve to the right connection.

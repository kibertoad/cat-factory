# VCS providers: GitHub vs GitLab

cat-factory acts on real code through a provider-neutral VCS layer (the `VcsClient`
port + the `vcs-registry`), so a workspace's repos can live on **GitHub** or
**GitLab**. GitHub (`@cat-factory/server`) is the reference implementation every
engine path (gates, requirements review, execution, merge) is built against;
GitLab (`@cat-factory/gitlab`) is an opt-in provider implementing the same ports.

This page is for anyone **choosing a provider or running both**: it is the authority for what each
one can actually do today. For implementation depth see
[`github-integration.md`](./github-integration.md) /
[`github-operations.md`](./github-operations.md) (GitHub) and
[`gitlab-parity.md`](./gitlab-parity.md) (the GitLab parity work log + conformance coverage + the
authoritative list of accepted gaps).

Two audiences share it, so it is ordered for both: the matrix and the setup steps first, then what
a contributor changing the layer has to keep true.

## Feature parity

| Capability                                                 | GitHub                                                                             | GitLab                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential model                                           | **App** installation: one credential scope per workspace                           | Single shared **token** (group/personal/OAuth PAT) per deployment                                                                                                                                                                                                                                                             |
| Multi-tenant credential isolation                          | ✅ per-installation token                                                          | ⚠️ one token for the whole deployment (mirrors local mode's PAT model)                                                                                                                                                                                                                                                        |
| Self-managed / on-prem instance                            | ✅ (GitHub Enterprise Server, via a configurable API base)                         | ✅ (`GITLAB_API_BASE`, any self-managed instance)                                                                                                                                                                                                                                                                             |
| Repo / branch reads                                        | ✅                                                                                 | ✅                                                                                                                                                                                                                                                                                                                            |
| File / directory reads                                     | ✅                                                                                 | ✅                                                                                                                                                                                                                                                                                                                            |
| Branch, commit, PR/MR create + write                       | ✅                                                                                 | ✅                                                                                                                                                                                                                                                                                                                            |
| PR/MR merge                                                | ✅                                                                                 | ✅                                                                                                                                                                                                                                                                                                                            |
| Update a PR/MR branch with its target                      | ✅ server-side branch merge (`mergeBranch`)                                        | ✅ via MR **rebase** (`rebasePullRequest`): GitLab has no branch-merge endpoint                                                                                                                                                                                                                                               |
| CI status (checks / pipelines)                             | ✅ Checks API                                                                      | ✅ Pipelines                                                                                                                                                                                                                                                                                                                  |
| Requested reviewers / submitted reviews                    | ✅                                                                                 | ✅ (approvals mapped to reviews)                                                                                                                                                                                                                                                                                              |
| Required approval count                                    | ✅ branch protection                                                               | ✅ MR approval rule                                                                                                                                                                                                                                                                                                           |
| Review threads (resolve / reply)                           | ✅                                                                                 | ✅ resolvable discussions                                                                                                                                                                                                                                                                                                     |
| PR/MR changed files (+ patches)                            | ✅ pull files API                                                                  | ✅ MR diffs API (`/changes` on pre-15.7), no per-file line counts, so they are counted off the hunk, and reported as UNREPORTED (not `0`) where GitLab withheld it                                                                                                                                                            |
| PR/MR head branch + head sha (deep-review fix / drift)     | ✅                                                                                 | ✅ (`source_branch` + `diff_refs.head_sha`)                                                                                                                                                                                                                                                                                   |
| Publish review findings as inline comments                 | ✅ per-comment, partial success reported                                           | ✅ per-comment diff discussions + a summary note, same partial-success reporting                                                                                                                                                                                                                                              |
| Issues: read / create / close / comment                    | ✅                                                                                 | ✅                                                                                                                                                                                                                                                                                                                            |
| Issue search                                               | ✅                                                                                 | ✅                                                                                                                                                                                                                                                                                                                            |
| Sub-issues (parent → child)                                | ✅                                                                                 | ❌ no native concept; method omitted, caller degrades gracefully                                                                                                                                                                                                                                                              |
| Issues as a **task source** (import, `bug-intake`, hunt)   | ✅ the `github` task source                                                        | 🟡 the `gitlab` task source imports, searches, diagnoses, and backs both the recurring `bug-intake` and the bug hunt (`issueType` does not narrow: GitLab has no "bug" type, so use labels); push intake and writeback are still open, tracked in [`gitlab-issues-intake.md`](../../docs/initiatives/gitlab-issues-intake.md) |
| Code search                                                | ✅                                                                                 | ❌ returns no results; needs Advanced Search (Elasticsearch); basic API can't supply a usable `owner/repo/url` per hit                                                                                                                                                                                                        |
| Webhooks: PR/MR, issue, push, CI status                    | ✅ HMAC-signed (`X-Hub-Signature-256`)                                             | ✅ token-header verified (`X-Gitlab-Token`)                                                                                                                                                                                                                                                                                   |
| Webhooks: install/connection lifecycle (removed/suspended) | ✅ (`installation` / `installation_repositories`)                                  | ❌ not mapped; a removed/suspended connection isn't pushed live                                                                                                                                                                                                                                                               |
| Periodic reconciliation (catches missed webhooks)          | ✅                                                                                 | ✅ (same cron path, provider-neutral)                                                                                                                                                                                                                                                                                         |
| Repo provisioning (create in org/group)                    | ✅ two-app tier: a separate privileged App, permissions introspected before create | ✅ single token, optimistic; capability discovered by attempting the create (403 on denial)                                                                                                                                                                                                                                   |
| User sign-in via pasted PAT                                | ✅                                                                                 | ✅                                                                                                                                                                                                                                                                                                                            |
| User sign-in via OAuth browser flow                        | ✅                                                                                 | ❌ PAT-only, no OAuth flow                                                                                                                                                                                                                                                                                                    |
| Sign-in allowlist by login / email domain                  | ✅                                                                                 | ✅                                                                                                                                                                                                                                                                                                                            |
| Sign-in allowlist by org / group membership                | ✅ (`AUTH_ALLOWED_ORGS` against orgs)                                              | ✅ (`AUTH_ALLOWED_ORGS` against group full paths)                                                                                                                                                                                                                                                                             |
| Listing pagination cap                                     | ~1000 items, warns on truncation                                                   | ~1000 items, warns on truncation                                                                                                                                                                                                                                                                                              |

## Setup

- **GitHub**: register a GitHub App; see [`github-integration.md`](./github-integration.md)
  for the architecture and [`github-operations.md`](./github-operations.md) for the
  step-by-step setup.
- **GitLab**: opt-in, off by default. Set `GITLAB_TOKEN` (enables the provider) and
  optionally `GITLAB_API_BASE` (self-managed instance, defaults to `gitlab.com`),
  `GITLAB_CONNECTION_ID`, and `GITLAB_WEBHOOK_SECRET` for webhook delivery. Both hosted
  facades (Node, Cloudflare Worker) and local mode wire it the same way.

`GITLAB_WEBHOOK_SECRET` is the one an operator most often arrives here for: a rejected GitLab
webhook delivery logs a remedy deep-linking this section, so keep the heading `## Setup` and keep
the variable named in it (`scripts/check-doc-links.mjs` fails the build otherwise).

## Where each half lives

| Concern                                   | Where                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The port every provider implements        | `kernel`'s `VcsClient` + the neutral identity types (`VcsProvider`, `VcsRepoRef`)                                                |
| GitHub, the reference implementation      | [`github-integration.md`](./github-integration.md) (design), [`github-operations.md`](./github-operations.md) (runbook)          |
| GitLab, adapted INTO the canonical client | [`gitlab-parity.md`](./gitlab-parity.md): the parity work log, conformance coverage, and the authoritative list of ACCEPTED gaps |
| Which surfaces the SPA may offer          | `GET /workspaces/:ws/vcs/connect-options`, plus `app/utils/vcs.ts`'s per-provider constants                                      |

**The accepted-gap list is `gitlab-parity.md`, not the matrix above.** The matrix states what a
user gets; the parity log states which gaps are deliberate, which are tracked, and what a
conformance suite already pins. A gap closed in code is two edits: the log there and the row here.

## The two facts that bite a change here

- **A provider's API base doubles as the WEB host** the SPA links repositories, merge/pull requests
  and issues to: `/api/v3` (GitHub Enterprise Server) and `/api/v4` (GitLab) are stripped,
  `api.github.com` maps to `github.com`, and a relative-URL install keeps its own prefix
  (`https://host/gitlab/api/v4` → `https://host/gitlab`). A base with none of those shapes names no
  host, and the SPA WITHHOLDS those links rather than pointing at the provider's public instance,
  where the same namespace path is very likely somebody else's project. Never fall back to the
  public instance.
- **Both API bases are read on EVERY deployment**, independently of the opt-in beside them
  (`GITLAB_TOKEN`, a GitHub App): a deployment reaching either provider with a PAT still has
  repositories to link, and local mode is exactly that shape. The opt-in governs the single-token
  engine connection alone, so gating the base read on it silently breaks local mode's links.

Both providers can be configured on one deployment at once: a workspace's repos just need to
resolve to the right connection. The naming rules that keep that true (never re-hardcode `github`,
never build a `https://github.com/...` URL) are in the root `CLAUDE.md`.

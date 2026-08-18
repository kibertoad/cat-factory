# VCS providers: GitHub vs GitLab

cat-factory acts on real code through a provider-neutral VCS layer (the `VcsClient`
port + the `vcs-registry`), so a workspace's repos can live on **GitHub** or
**GitLab**. GitHub (`@cat-factory/server`) is the reference implementation every
engine path (gates, requirements review, execution, merge) is built against;
GitLab (`@cat-factory/gitlab`) is an opt-in provider implementing the same ports.

> **The capability comparison is on the website**:
> [GitHub and GitLab Support Matrix](https://www.catfactory.ai/reference/vcs-support-matrix.html)
> is the authority for anyone CHOOSING a provider or running both, and the setup steps live beside
> it under [Deploy](https://www.catfactory.ai/deploy/github-app.html). Land a capability change
> there in the same PR: a matrix that lags the code is worse than no matrix, because it is read as
> a promise.

This page keeps what a contributor needs: which layer owns what, and where the gaps are recorded.

## Where each half lives

| Concern                                   | Where                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The port every provider implements        | `kernel`'s `VcsClient` + the neutral identity types (`VcsProvider`, `VcsRepoRef`)                                                |
| GitHub, the reference implementation      | [`github-integration.md`](./github-integration.md) (design), [`github-operations.md`](./github-operations.md) (runbook)          |
| GitLab, adapted INTO the canonical client | [`gitlab-parity.md`](./gitlab-parity.md): the parity work log, conformance coverage, and the authoritative list of ACCEPTED gaps |
| Which surfaces the SPA may offer          | `GET /workspaces/:ws/vcs/connect-options`, plus `app/utils/vcs.ts`'s per-provider constants                                      |

**The accepted-gap list is `gitlab-parity.md`, not the website matrix.** The matrix states what a
user gets; the parity log states which gaps are deliberate, which are tracked, and what a
conformance suite already pins. A gap closed in code is two edits: the log here and the matrix
there.

## The three facts that bite a change here

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
- **The same inversion decides where an agent container CLONES from**, through
  `deploymentRepoOrigin` (the `ResolveRepoOrigin` seam) plus `harnessGitLabHost` (the harness's
  clone-credential allow-list, which defaults to github.com and refuses anything else). Both hosted
  facades wire them and local mode reads the same derivation, so the host a run checks out and the
  host a link points at cannot disagree. Two things follow. A base that does not invert THROWS here
  rather than withholding, because a fallback to `github.com` checks out somebody else's project and
  reports it as the run's repository. And the rule is `engineVcsClient`'s (the App wins wherever
  both are configured), so a mixed deployment clones GitHub for every workspace until per-workspace
  engine routing lands: see [`gitlab-parity.md`](./gitlab-parity.md)'s accepted gaps.

Both providers can be configured on one deployment at once: a workspace's repos just need to
resolve to the right connection. The naming rules that keep that true (never re-hardcode `github`,
never build a `https://github.com/...` URL) are in the root `CLAUDE.md`.

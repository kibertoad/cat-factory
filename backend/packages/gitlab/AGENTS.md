# `@cat-factory/gitlab` — opt-in GitLab VCS provider

Implements the provider-neutral `VcsClient` / webhook / provisioning ports (kernel) against the
GitLab REST v4 API and self-registers via `registerVcsProvider('gitlab')`. Kernel + contracts
only.

**Entry:** `src/index.ts` (import for side effect). `FetchGitLabClient.ts` is the client. The
GitHub analogue lives in `@cat-factory/server` (`FetchGitHubClient`) + `@cat-factory/integrations`.

**Where things live:** `projection.ts` — pure GitLab-payload → neutral-entity mappers;
`reviewPosting.ts` — the deep-review "post" resolution (the mirror of `@cat-factory/server`'s
file of the same name; keep the two behaviourally identical); `webhook.ts` — verifier + mapper;
`provisioning.ts`, `tokenSource.ts`, `GitLabIdentityResolver.ts`; `vcsBackedGitHubClient.ts` —
the `VcsClient` → legacy `GitHubClient` bridge, which exposes each OPTIONAL method only when the
underlying client implements it.

Optional `VcsClient` methods are a trap: every consumer degrades **silently** when one is absent,
so adding a capability here also means asserting its PRESENCE in the cross-provider conformance
suite (`runtimes/local/src/vcs-conformance.test.ts`). The current accepted gaps are listed in
[`backend/docs/gitlab-parity.md`](../../docs/gitlab-parity.md).

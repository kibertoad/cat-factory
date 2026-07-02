# `@cat-factory/gitlab` — opt-in GitLab VCS provider

Implements the provider-neutral `VcsClient` / webhook / provisioning ports (kernel) against the
GitLab REST v4 API and self-registers via `registerVcsProvider('gitlab')`. Kernel + contracts
only.

**Entry:** `src/index.ts` (import for side effect). `FetchGitLabClient.ts` is the client. The
GitHub analogue lives in `@cat-factory/server` (`FetchGitHubClient`) + `@cat-factory/integrations`.

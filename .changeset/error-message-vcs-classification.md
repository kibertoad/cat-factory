---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/gitlab': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Classify VCS (GitHub / GitLab) HTTP failures with cause + fix + doc links (error-message coverage
initiative, items C1/C4/C5/C6). The `fetch`-based clients used to throw the same bare status dump
for any non-2xx (`GitHub GET <url> → 401: <body>`), so a revoked token, an exhausted rate limit,
and a missing scope all read identically.

- Adds a shared kernel helper `describeVcsApiError` (`@cat-factory/kernel` `domain/vcs-errors.ts`)
  that maps `{ provider, status }` to a remedy. It PRESERVES the raw
  `<Provider> <method> <url> → <status>: <body>` first line (detectors still surface it and it stays
  greppable) and APPENDS a cause + remedy sentence: 401 → token revoked/expired (reconnect the App,
  or refresh `GITHUB_PAT` in local mode); 403 + rate-limit headers / 429 → rate limited, wait for
  the reset (App has a higher limit than a PAT); 403 → missing permission/scope + where to grant it;
  404 → repo/installation not visible to the token. GitLab gets the same shapes, GitLab-flavoured
  (`api` scope, Developer/Maintainer role). Kernel sits below the server layer so it keeps its own
  `VCS_DOC_URLS` (per the doc-URL convention) linking `backend/docs/github-integration.md` /
  `github-operations.md` / `vcs-providers.md`.
- **C1/C6** — `FetchGitHubClient` (REST `request()` + PAT `requestWithToken()`) and
  `FetchGitLabClient.request()` / `provisioning.ts` now build their `*ApiError` message through the
  helper. Error identity still rides the structured `status` field, so classification is unchanged.
- **C5** — `Installation X not found on any configured App` now explains the App was likely
  uninstalled or the workspace points at a stale installation, and to reconnect GitHub.
- **C4** — `No connected GitHub repository found for workspace 'X'` (`ContainerAgentExecutor`) is now
  a `ConflictError` carrying the existing `github_not_connected` reason (was a plain `Error` → 500),
  with a UI-first remedy pointing at the GitHub connect / repo-linking flow. The SPA already maps
  that reason to a translated title.
- **C4 (async run path)** — the durable dispatch previously caught EVERY `startJob` throw and framed
  it as a container `dispatch` failure ("The container failed to start."), so a `github_not_connected`
  precondition reached the board mislabeled and lost its `reason`. `classifyDispatchFailure`
  (`job.logic.ts`) now distinguishes a pre-dispatch domain precondition (any `DomainError`) as a
  `preflight` failure that keeps its own actionable message and propagates its `reason`, so
  `AgentFailureCard` titles it with the same translated "GitHub not connected" string the 409 toast
  uses (no new locale keys) and shows the remedy in the detail.

No behaviour changes beyond error identity (C4's 409 + `preflight` classification on the async path)
and message text.

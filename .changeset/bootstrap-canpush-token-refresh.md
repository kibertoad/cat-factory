---
'@cat-factory/server': patch
---

Bootstrap write-permission check now rechecks with a freshly minted installation
token before concluding the App lacks write access. Installation tokens bake in
their repo set and permission scopes at mint time and are cached in-memory for ~1h,
so a token minted before the user granted the App access kept reporting the old
no-write grant — meaning a bootstrap retry, even right after adding the App to the
repo, would still fail. `FetchGitHubClient.canPush` now mints a fresh token and
probes once more on a negative answer (only on the failure path, so the happy path
pays nothing). The fresh mint also replaces the cached entry the container's push
token reads, so a real grant fixes the push too. `installationToken` gains an
optional `{ forceRefresh }` across `AppTokenSource` / `GitHubAppRegistry` /
`GitHubAppAuth`.

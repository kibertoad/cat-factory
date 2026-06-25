---
'@cat-factory/server': patch
---

Fix the bootstrap write-permission pre-flight (`FetchGitHubClient.canPush`), which
never passed for a GitHub App installation (only for local-mode PATs).

Two bugs:

1. Wrong source of truth. The check read the repo object's `permissions.push`, which
   reflects a user/collaborator role. A GitHub App installation token isn't a
   collaborator, so that field is empty for it and `push` is never true regardless of
   the grant. The authoritative signal for an App is its granted `contents` scope from
   the token mint response. `canPush` now consults `installationPermissions` (added to
   the `AppTokenSource` seam) and treats `contents: 'write'` as pushable, keeping the
   repo-object role as the path for user/PAT tokens.

2. Stale token. Installation tokens bake in their grant at mint time and are cached
   in-memory for ~1h, so a token minted before the user granted access kept reporting
   the old grant — a retry right after adding the App would still fail. `canPush` now
   mints a fresh token and rechecks on a negative answer (failure path only). The fresh
   mint also replaces the cached entry the container's push token reads, so a real grant
   fixes the push too. `installationToken` gains an optional `{ forceRefresh }` across
   `AppTokenSource` / `GitHubAppRegistry` / `GitHubAppAuth`.

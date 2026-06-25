---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
---

Pre-flight write access before a repo bootstrap. Bootstrapping ends in a force-push,
but a public target the GitHub App can *read* (not in the App's selected-repos list,
or the App lacking `contents:write`) passes the existing existence/emptiness checks
and only fails deep inside the container with a `403` on `git push`. The bootstrapper
now verifies the installation actually has push access up front (new
`GitHubClient.canPush`, reading the token's effective `permissions.push`) and fails
fast with an actionable error — "grant the App write access to this repository, or use
a GitHub PAT" — before any board frame is created.

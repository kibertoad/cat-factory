---
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Move the "Login with GitHub" OAuth flow into `@cat-factory/server`. `AuthController`
and its fetch-based `GitHubOAuth` client are runtime-neutral, so they now live in
the shared package and are mounted via `registerCoreControllers`. The Worker keeps a
thin re-export shim for backward-compatible imports. Behaviour is unchanged.

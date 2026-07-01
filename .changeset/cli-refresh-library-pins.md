---
'@cat-factory/cli': patch
---

Refresh the scaffolded project's pinned library versions so `cat-factory init`
emits an up-to-date local-mode deployment. `@cat-factory/local-server` was pinned
at `^0.19.5` (published `0.33.0`) and `@cat-factory/app` at `^0.47.7` (published
`0.63.1`), so a freshly scaffolded project resolved badly stale backend/frontend
libraries. Bumped both pins to the current published majors.

Also note the local-mode sign-in step in the generated `README.md`: local mode
requires sign-in, and because the CLI writes the provider PAT, the login screen
offers "Sign in with configured PAT" — the generated run instructions now say so.

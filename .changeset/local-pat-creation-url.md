---
'@cat-factory/local-server': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Local mode now warns when no GitHub PAT is configured — in the UI, not just the
console. At boot, `startLocal()` still logs a warning, but the local facade also tags
its `AppConfig` with a `localMode` block carrying a GitHub "new personal access token
(classic)" URL (scopes pre-selected: `repo`, `workflow`) when `GITHUB_PAT` is unset.
The shared `/auth/config` endpoint surfaces that block, and the SPA renders a
dismissible banner with a one-click link straight to the token-creation page, so the
prompt isn't lost in a dev terminal. Exposed as `githubPatCreationUrl()` from the local
facade and `LocalModeConfig` from `@cat-factory/server`.

---
'@cat-factory/local-server': patch
'@cat-factory/contracts': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Local mode: env-PAT sign-in that's remembered across restarts.

Local-mode sign-in is now purely **provider selection** — a "Sign in with configured
GitHub/GitLab PAT" button for whichever of `GITHUB_PAT` / `GITLAB_PAT` is set in env. The
paste-a-token textarea is **removed**: a pasted token only ever resolved an identity (it never
became the operational clone/push token, which comes from env), so it was a dead-end. When
neither PAT is configured, the login screen shows an informational notice (with scopes-preset
token-creation links) instead of an empty form; email/password sign-in is unchanged.

The chosen provider (a non-secret label — never the token) is remembered in `localStorage`, so
on a later load the SPA silently re-mints a session from the env PAT without showing the login
screen. Logout/401 clears it, so logout sticks (no re-login loop). The PAT never leaves the
server.

The auto-generated local `AUTH_SESSION_SECRET` is now **persisted** to `~/.cat-factory/`
(override with `CAT_FACTORY_STATE_DIR`; an explicit env value still wins) so a signed-in
session survives a server restart instead of being invalidated by a fresh per-process secret —
the original cause of "re-enter the PAT every time" in local dev.

**Breaking (pre-1.0, no migration):** the `localMode.patLogin.available` field is removed from
the auth-config wire shape; only `configured` + `setupUrls` remain.

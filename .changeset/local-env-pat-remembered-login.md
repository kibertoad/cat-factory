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
screen. Logout clears it (so logout sticks, no re-login loop); a transient/expiry 401 keeps it
so the next load re-mints rather than bouncing to the login screen. The PAT never leaves the
server.

`AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are now **required** in local mode (no longer
auto-generated per process). The per-process auto-generation was the original cause of "re-enter
the PAT every restart" — a fresh session secret each boot invalidated the persisted session, and
a fresh encryption key orphaned credentials sealed at rest. Boot now **fails loudly** with an
actionable message when either is unset. A new `pnpm secrets` script in `deploy/local` prints
both in the correct format (cross-platform, no `openssl` needed) to paste into `.env`.

**Breaking (pre-1.0, no migration):**
- the `localMode.patLogin.available` field is removed from the auth-config wire shape; only
  `configured` + `setupUrls` remain.
- local mode no longer auto-generates `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`; both must be set
  in the environment (generate via `pnpm secrets`).

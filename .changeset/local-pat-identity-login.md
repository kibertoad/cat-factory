---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Local mode: sign in with a source-control PAT (GitHub or GitLab) or email/password.

Local mode previously ran fully anonymous (dev-open, no user), so per-user features —
personal subscriptions, your own API keys — failed with 401 ("Sign in to manage …") with
no way to sign in. Local mode now establishes a real identity:

- A new provider-agnostic `VcsIdentityResolver` port (kernel) turns a raw PAT into a
  neutral identity (the provider's stable numeric user id — the SAME subject GitHub OAuth
  uses, so a PAT login and an OAuth login resolve to one canonical user). GitHub and GitLab
  resolvers ship in `@cat-factory/server` / `@cat-factory/gitlab`; adding an Nth provider is
  one more resolver entry, no endpoint or UI changes.
- A new `POST /auth/pat` endpoint (served only where resolvers are wired — local mode)
  mints a session for the account a PAT belongs to. The local login screen offers one-click
  "Continue with GitHub/GitLab" when a `GITHUB_PAT`/`GITLAB_PAT` is configured, an inline
  "paste a PAT" form otherwise, and email/password sign-in (enabled by default in local
  mode, with open signup on the developer's own machine).
- The SPA now requires sign-in in local mode (anonymous use can't store per-user
  credentials); the session is honored even though the API otherwise runs dev-open.
- `'gitlab'` is now an identity provider. Identities remain collision-safe via the
  `(provider, subject)` key: a GitHub user and a GitLab user with the same numeric id, and
  a password account (keyed on email), are always distinct.

Also adds a guard on the per-user credential forms (personal subscriptions, your own API
keys): when there is genuinely no signed-in user (a non-local deployment running with auth
disabled), the inputs are blocked with a clear notice instead of accepting data that can't
be saved.

BREAKING (local mode only): existing anonymously-created local boards have no owner, so
after upgrading they become inaccessible once sign-in is required — recreate them under
your signed-in account. (Pre-1.0, no data migration.)

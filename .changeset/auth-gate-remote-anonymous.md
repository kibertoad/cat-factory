---
'@cat-factory/app': minor
'@cat-factory/server': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/node-server': minor
---

feat(auth): remote node mode — surface the unauthenticated state and support PAT sign-in.

- A remote facade (node service / Worker) has no anonymous tier, so once the auth handshake
  resolves with no signed-in user the SPA now routes to the login screen — even when the
  backend reports auth "disabled" (a dev-open / unconfigured remote). Previously this dropped
  the user onto a board where every per-user action silently failed with no sign-in affordance.
  An unreachable backend still falls through to the board's own error UI.
- Source-control PAT sign-in now works on the remote node facade: a user pastes their own
  GitHub/GitLab PAT and is resolved to the account it belongs to. A hosted PAT login is held
  to the SAME login/org/domain allowlist as GitHub OAuth (admit when the login, an org it
  belongs to, or its email domain is allowlisted; fail closed when none are configured). Local
  mode keeps its configured-token, allowlist-exempt flow. `GET /auth/config` advertises the
  available PAT providers and the login screen renders a PAT option alongside OAuth/password;
  when a remote deployment has no sign-in method at all the screen explains that instead of
  showing a blank card.

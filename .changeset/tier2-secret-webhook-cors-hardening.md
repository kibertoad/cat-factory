---
'@cat-factory/local-server': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Boundary hardening:

- **Local mode** now enforces a minimum strength on the required crypto secrets at config
  load: `AUTH_SESSION_SECRET` must be ≥32 characters (local mode defaults the auth gate open,
  so a weak secret would leave session/proxy/machine tokens forgeable) and `ENCRYPTION_KEY`
  must decode to a full 32-byte key (surfaced early instead of deep in the first cipher build).
- **GitHub webhook verifier** fails closed when the webhook secret is unset (previously it would
  import an empty HMAC key and compare), matching the GitLab verifier.
- **CORS** no longer reflects an arbitrary Origin by default outside development: an unset
  `CORS_ALLOWED_ORIGINS` reflects any origin only when `ENVIRONMENT` is an explicitly
  recognised development value (`development`/`dev`/`test`/`testing`/`local`/`e2e`). An
  unset, unknown, or production `ENVIRONMENT` default-denies (fails safe), so a deployment
  that forgets BOTH `ENVIRONMENT` and `CORS_ALLOWED_ORIGINS` no longer silently reflects.
  An explicit `*` still opts into reflect-all.

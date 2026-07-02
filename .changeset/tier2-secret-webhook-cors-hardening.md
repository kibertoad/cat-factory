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
- **CORS** no longer reflects an arbitrary Origin by default in production: an unset
  `CORS_ALLOWED_ORIGINS` reflects any origin only in a non-production `ENVIRONMENT`
  (dev/test convenience); a production deployment that forgets to set it now default-denies
  cross-origin. An explicit `*` still opts into reflect-all.

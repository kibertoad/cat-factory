---
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Elaborate two boot-time connectivity failures with actionable remedies (error-message coverage
A11/A12):

- **A11 (Node):** a loopback Postgres connection that's refused or reset at boot now reports the
  fix on the misconfigured screen — including the Windows/Docker-Desktop `localhost`→IPv6 `::1`
  footgun and the `127.0.0.1` workaround — instead of dying with a raw `ECONNRESET`. A non-loopback
  (remote) database being briefly unreachable is deliberately left to crash-and-retry.
- **A12 (Local):** a set-but-invalid `GITHUB_PAT` is validated once at boot (a best-effort
  `GET /user`) and, when it's expired/revoked/under-scoped, warned about with the same pre-scoped
  token-creation link the missing-PAT warning already uses — instead of failing opaquely on the
  first clone/push/PR later.

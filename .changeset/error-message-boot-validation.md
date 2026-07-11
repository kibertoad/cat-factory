---
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Boot-time configuration validation for three previously-opaque failures (error-message
coverage initiative, items A2/A4/A6):

- **A2** — the system `ENCRYPTION_KEY` is now validated at config load on every facade
  (present, valid base64, decoding to a full AES-256 key) via a shared
  `requireEncryptionKey` helper in `@cat-factory/server`, wired into the Node and Worker
  config loaders and reused by local mode. A malformed key fails with an actionable,
  doc-linked message on the misconfigured screen instead of lazily deep inside the first
  cipher build (a bare "must decode to at least 32 bytes" or an opaque `atob` error).
- **A4** — the Cloudflare Worker's primary `DB` binding is guarded by `requireDb` at
  container build, mirroring `requireTelemetryDb`, so an unbound/misnamed binding fails
  fast with a `[[d1_databases]]` remedy rather than NPE-ing deep in the first repository
  call.
- **A6** — an invalid `DB_SCHEMA` / `DB_MIGRATIONS_SCHEMA` on the Node facade now throws a
  `ConfigValidationError`, so it reaches the "backend misconfigured" fallback screen
  instead of hard-crashing the process with an opaque message.

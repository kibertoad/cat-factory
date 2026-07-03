---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add a public, key-authenticated external API (`/api/v1`) whose first use-case is "break down an
initiative": an external system picks a public, inline pipeline and posts a brief, and the platform
runs it headlessly and persists the result in the DB for asynchronous retrieval (poll
`GET /api/v1/jobs/:id` or stream `GET /api/v1/jobs/:id/events` over SSE). Nothing is committed to
GitHub — the run uses an inline agent (`initiative-breakdown`) with no container/repo.

- Inbound public-API keys (`public_api_keys`, mirrored D1 ⇄ Drizzle) are revocable and stored as a
  one-way peppered hash (`HMAC-SHA256(secret, ENCRYPTION_KEY)`) — never plaintext, never
  recoverable. Managed per-workspace via `GET|POST|DELETE /workspaces/:ws/public-api-keys`; the raw
  key is shown once on create.
- Runs are anchored on a headless `internal` block excluded from every board projection, so the
  external runs never appear in the UI.
- Requires `ENCRYPTION_KEY` (the HMAC pepper); the surface 503s when unconfigured.

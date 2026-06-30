---
'@cat-factory/local-server': minor
---

Add the mothership-mode local `node:sqlite` credential store (the consumer-side foundation
of the mothership-mode initiative). In mothership mode a local node keeps NO main database —
org/durable state is forwarded to the hosted mothership over the persistence RPC — but the
agent/model credentials stay on the developer's machine, sealed with the LOCAL key so the
mothership's `ENCRYPTION_KEY` never reaches the laptop. This ships their persistence: a
file-based `node:sqlite` store implementing the two `local-sqlite` bucket ports,
`SqliteProviderApiKeyRepository` (the direct-vendor API-key pool, with usage-window rotation
and atomic lease-least-used) and `SqliteLocalModelEndpointRepository` (per-user local model
endpoints), behind a `createLocalCredentialStore(path)` factory. The schema and behaviour
mirror the Drizzle/D1 repositories column-for-column so a mothership-mode node pools and
rotates keys identically to a Postgres one. Not yet wired into `buildLocalContainer` — the
`LOCAL_MOTHERSHIP_URL` composition switch + no-Postgres boot land in the next slice.

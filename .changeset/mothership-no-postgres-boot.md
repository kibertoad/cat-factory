---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Mothership mode: the no-Postgres local boot (initiative slice 1b). A local node can now run
with `LOCAL_MOTHERSHIP_URL` set and NO local database — org/durable state is served by the
hosted mothership over the `/internal/persistence` machine API, while agent/model credentials
stay on the laptop in the `node:sqlite` store (sealed with the LOCAL key; the mothership's
`ENCRYPTION_KEY` never reaches the machine).

- `@cat-factory/server`: `createRemoteRepositoryRegistry(client)` — a drift-proof, full-surface
  remote repository set (a `Proxy` that lazily forwards any accessed repository to one RPC), so a
  mothership-mode node backs its entire `CoreRepositories` surface remotely with no per-repo
  wiring. The server-side allow-list still gates which repo+method actually executes.
- `@cat-factory/node-server`: `buildNodeContainer` now tolerates `db: undefined` — the per-user
  Postgres services (subscriptions, user secrets, OpenRouter catalog) turn themselves off, the
  API-key pool + local-model endpoints accept injected repositories, and the composite `repos`
  is required in that mode. Re-exports the execution driver + realtime pieces the local
  mothership boot reuses.
- `@cat-factory/local-server`: `composeMothership` wires the remote repos + the local credential
  store; `buildLocalContainer` composes them with `db: undefined`, injects the credential repos,
  and drives runs with the new in-process `WorkRunner` (the no-pg-boss analogue, serialized per
  execution); `startLocal()` takes the dedicated no-Postgres boot path automatically when
  `LOCAL_MOTHERSHIP_URL` is set.
- `@cat-factory/contracts`: `localModeConfig.mothership` is surfaced to the SPA so the UI can
  label what is stored locally vs delegated to the mothership.

Scope note: the pilot allow-list still exposes only the six core domain repositories remotely,
so a mothership node loads a hosted board and persists executions; the full repository surface
and login-based machine-token minting land in PR 3 (a static `LOCAL_MOTHERSHIP_TOKEN` is used
for now). Pre-1.0, no back-compat: the standard siloed-Postgres local mode is unchanged when
`LOCAL_MOTHERSHIP_URL` is unset.

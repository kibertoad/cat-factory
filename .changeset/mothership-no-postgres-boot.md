---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Mothership mode: the no-Postgres local boot SPINE (initiative slice 1b). A local node can now
boot with `LOCAL_MOTHERSHIP_URL` set and NO local database: it composes the remote (RPC-backed)
org repositories + a local `node:sqlite` credential store (sealed with the LOCAL key; the
mothership's `ENCRYPTION_KEY` never reaches the machine) and drives runs with an in-process work
runner instead of pg-boss.

NOT yet functional end-to-end — keep the mothership PR a DRAFT. The pilot allow-list exposes only
the six core domain repositories remotely, but a board load and a run reach many more org repos
(mounts, settings, presets, notifications, projections, …) plus stores still built from the
now-absent local `db`, so those paths currently throw. Routing the full repository surface through
the remote registry + widening the server allow-list (with the per-method account/role scope rules
that boundary needs) is the gating phase in `docs/initiatives/mothership-mode.md`; this work must
not merge until that phase lands. See the tracker for the per-repo task list.

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

Login-based machine-token minting also lands later (a static `LOCAL_MOTHERSHIP_TOKEN` is used for
now). Pre-1.0, no back-compat: the standard siloed-Postgres local mode is unchanged when
`LOCAL_MOTHERSHIP_URL` is unset.

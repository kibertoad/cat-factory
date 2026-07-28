---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Give a workspace a DEFAULT test-environment provisioning mechanism, suggested for every service
added afterwards, and prompt for it when a board has never chosen one.

Declaring a provision type per service (ADR 0007) is right, but it made the common case — a board
where every service provisions the same way — a per-service chore, and a service nobody got to
silently produced no test environment at all. `workspace_settings` gains
`defaultProvisionType` + `defaultProvisionManifestId` (D1 + Drizzle, with a conformance
assertion), and `BoardService` stamps them onto every newly created service frame via both
creation paths, alongside the existing default fragment selection.

The pair is nullable rather than defaulted, and the distinction is the feature: `null` means the
operator has never chosen — what the new `DefaultTestEnvBanner` nags about, which covers a
manually created board, the board the SPA creates implicitly on first launch, and an older board
predating the setting under one condition — while `infraless` is a real decision ("services stand
up no environment") that silences it. The banner carries a shareable `?settings=default-test-env`
deep link to the Infrastructure window's Test-environments tab, where the new section preselects
the first REGISTERED custom provider when the deployment shipped one and nothing is stored yet
(unsaved, and labelled as a suggestion until saved).

The seed is creation-time only: the engine still reads a service's own `provisioning`, so changing
the default never retroactively alters an existing service. `WorkspaceSettingsService.update`
refuses a `custom` default with no manifest id and clears a stale id when switching away, since a
`custom` service pinning nothing matches no `remote-custom` handler.

`BoardService`'s `reviewFrictionSettings` dependency is renamed to `workspaceSettings` (one reader
now feeds both the friction guard and the provisioning seed), and the frame-creation defaults move
into a `newServiceFrameDefaults` collaborator.

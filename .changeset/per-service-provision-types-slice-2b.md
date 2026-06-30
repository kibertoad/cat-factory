---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': patch
---

Per-service provision types (slice 2b — reshape `environment_connections` + handler-aware
service). **Breaking:** `environment_connections` is rekeyed from a single per-workspace
provider binding (`(workspace_id, provider_id)`, discriminated by `kind`) into a multi-row
per-provision-type HANDLER table `(workspace_id, provision_type, manifest_id)` with
`engine` / `backend_kind` / `accepts_manifest_id` columns and `handler_json` (was
`manifest_json`); pre-reshape rows are dropped (BC is a non-goal). The kernel
`EnvironmentConnectionRepository` port becomes a multi-row API (`listByWorkspace`,
`getByWorkspaceAndType`, `upsert`, per-type `softDelete`), mirrored in the D1 + Drizzle repos
and the cross-runtime conformance suite.

`EnvironmentConnectionService` gains the final handler-aware API — `registerHandler` /
`listHandlers` / `updateHandlerSecrets` / `unregisterHandler`, custom-manifest-type CRUD, and
`resolveProviderForType`, which matches a service's declared provisioning to a workspace
handler and **merges the service-owned `manifestSource` into the engine config** at resolve
time (the what/where ÷ how split). `EnvironmentProvisioningService.provision` accepts the
service's `provisioning` and resolves per-type (short-circuiting `infraless`). A new
`provision_type_unhandled` conflict reason is added (wire vocabulary + SPA title).

The existing single-connection HTTP surface (register/describe/test/connection endpoints) is
preserved as a thin **compat bridge** over the new table, so the current infrastructure UI
keeps working unchanged; the per-type HTTP endpoints + the frontend rebuild follow in later
slices, as does the tester collapse (dropping `defaultTestEnvironment`).

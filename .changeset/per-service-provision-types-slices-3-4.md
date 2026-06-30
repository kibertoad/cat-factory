---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Per-service provision types (slices 3 + 4): the deployer engine step + run-details recording,
and the per-type handler controllers + container wiring.

Slice 3 — engine step:

- The `deployer` step now resolves the SERVICE frame's declared `provisioning` and routes to the
  workspace handler for its type (merging the service's manifest source). A service declaring
  `infraless` records a no-op step output (nothing provisioned); an undeclared service falls
  through to the legacy single-connection path. The resolved provision type + engine are recorded
  on the `EnvironmentRecord` (success and failed paths) and surfaced on the step output
  (`Provision type:` / `Engine:` lines + `model: environment:<engine>:<providerId>`).
- `EnvironmentProvisioningService.provision` gains an `initiatedBy` arg and a
  `resolveUserHandlerOverrides` seam: in local mode the run initiator's per-user handler
  overrides layer over the workspace handlers.

Slice 4 — controllers + wiring:

- New per-type infra handler HTTP surface on `EnvironmentController` (workspace-scoped): a batched
  `GET …/environments/handlers` bundle (handlers + custom-type catalog), `POST …/handlers`,
  `PATCH …/handlers/:provisionType/secrets`, `DELETE …/handlers/:provisionType`, plus custom-type
  CRUD (`PUT|DELETE …/environments/custom-types/:manifestId`).
- New **local-mode-only** `EnvironmentUserHandlerController` mounted at the root
  (`GET /me/environment-handlers/:workspaceId`, `PUT|DELETE …/:provisionType`), backed by the new
  `EnvironmentUserHandlerService`. The service + per-user overrides are wired ONLY by the local
  facade (Worker/Node 503 the controller and ignore user overrides), enforced purely by container
  wiring.
- `customManifestTypeRepository` is wired on all three facades (workspace catalog CRUD);
  `environmentUserHandlerRepository` only on the local facade.
- The handler validation/lowering is extracted to a shared `buildInfraHandlerFields` helper used by
  both the workspace and per-user stores. Cross-runtime conformance asserts the per-type handler
  CRUD + custom-type CRUD + the `infraless` deployer no-op on every facade.

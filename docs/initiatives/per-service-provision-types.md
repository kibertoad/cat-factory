# Per-service provision type + per-type infra handlers

> Initiative tracker + plan of record. A later iteration reads this FIRST to resume
> without re-deriving context. This is the durable plan; capture every decision here.

## Goal & rationale

Today an ephemeral environment is provisioned from a **single `environment_connections`
row per workspace** (`kind` ∈ `manifest`/`kubernetes`/custom), and a per-service
`defaultTestEnvironment` toggle (`local` compose vs `ephemeral` provisioned) drives the
Tester. There is no way to say "this service deploys Kubernetes manifests, that one a
docker-compose file, a third a custom manifest" and route each to a different engine.

Target end state — the **what/where ÷ how split** (confirmed with the requester):

- **The service (repo) owns its provisioning config — the "what + where".** A
  service-frame `Block` declares a `provisionType` (`kubernetes` | `docker-compose` |
  `custom` | `infraless`) plus the in-repo specifics: where its k8s manifests live
  (**colocated path or a separate repo**), its compose path, or its custom `manifestId`.
  Add-service **auto-detects a non-binding suggestion** (presence of k8s manifests /
  docker-compose).
- **The workspace (and, in local mode, the user) owns HOW to handle each type — the
  "how".** Per provision type, an **engine** + connection: `local-docker`, `local-k3s`,
  `remote-kubernetes`, or a `remote-custom` provider (which declares the `manifestId` it
  accepts). A **per-user override** layers over the workspace handler in local mode.
- **One uniform path — no local/ephemeral toggle.** `defaultTestEnvironment` is removed.
  Every service gets its environment from the workspace's handler for its declared type;
  a `local-docker` handler (a local compose stack) and a remote cluster are just two kinds
  of handler. `infraless` = no environment. Local-vs-remote is purely _which handler the
  workspace configured_ — never a user-facing toggle or a special tester branch.

The clean split: **service = what/where** (type + manifest source); **workspace/user =
how** (the handler/engine + connection). The deployer **merges** the two at run time. Run
details surface the exact resolved **provision type + engine + provider**.

Custom types are an **open catalog** keyed by `manifestId`: programmatically-registered
providers **plus** workspace-defined (UI-editable) entries. A `remote-custom` handler's
`acceptsManifestId` is matched against a service's pinned id.

## Conventions & gotchas (carried between slices)

- **Runtime symmetry**: every table/column/migration lands in D1 **and** Drizzle **and** a
  cross-runtime conformance assertion, in the same change (CLAUDE.md "Keep the runtimes
  symmetric").
- **BC is a non-goal**: reshape `environment_connections`, drop `defaultTestEnvironment`,
  split the kube config cleanly — no dual-read shims; stale rows may break.
- **No N+1**: resolution batches (`listByWorkspace` + `listByUserWorkspace` + catalog
  list), resolve in memory.
- **`manifestSource` moves from the workspace kube config onto the SERVICE.** The provider
  is built by **merging** the service's `manifestSource` with the workspace engine config
  at provision time.
- **local-only per-user override**: enforced by controller mount + container wiring (only
  the local facade wires the service), not a runtime branch in shared code.
- **Keep each commit green.** The single→multi reshape of the EXISTING
  `environment_connections` table breaks its sole consumer (`EnvironmentConnectionService`),
  so it is grouped with its service consumption (slice 2b), NOT with the additive
  foundation (slice 1). Only commit a slice once `pnpm typecheck` + the touched
  conformance/unit suites are green on both runtimes.

## Target pattern (reference implementations to mirror)

- **observability-connection / release-health-config** (per-workspace sealed connection +
  per-block config resolved up the frame chain) — the closest analog for the handler
  config + resolution.
- **`local_model_endpoints`** (per-USER table, D1 ⇄ Drizzle, user-scoped controller with
  no `/workspaces` prefix) — the template for the per-user override + custom-type catalog.
- The **custom-type registry** mirrors the `EnvironmentBackendRegistry` / `registerAgentKind`
  registration seam.

---

## Implementation plan (per slice)

### Slice 1 — contracts (additive) + new tables + ports + repos + conformance ✅

- Contracts (`backend/packages/contracts/src/environments.ts`): `provisionTypeSchema`,
  `infraEngineSchema`, `manifestIdSchema`, `serviceProvisioningSchema`,
  `kubernetesEngineConfigSchema` (the split-out kube _engine_ config), `infraHandlerConfigSchema`
  (discriminated by `engine`), `customManifestTypeSchema` + `upsertCustomManifestTypeSchema`;
  `provisionType`/`engine` on `environmentHandleSchema`. `entities.ts`: a `provisioning`
  field on the service-frame `Block` (additive; `defaultTestEnvironment` kept for now).
- Kernel ports (`environment-repositories.ts`): `EnvironmentUserHandlerRepository` +
  `CustomManifestTypeRepository`; `provisionType`/`engine` on `EnvironmentRecord` (+ patch).
- Persistence (D1 migration `0024` ⇄ Drizzle schema + generated migration): new
  `environment_user_handlers` (per-user override; PK `(user_id, workspace_id,
provision_type, manifest_id)`, `manifest_id` `''` sentinel for non-custom) and
  `custom_manifest_types` (PK `(workspace_id, manifest_id)`); `provision_type`/`engine`
  columns on `environments`. D1 + Drizzle repos.
- Conformance: `defineEnvironmentHandlersSuite` (upsert/list/remove, the `''`⇄`null`
  sentinel, catalog CRUD), invoked from both runtimes.

### Slice 2a — resolver + registry engine metadata + custom-type seam ✅

- `infra-handler.logic.ts`: pure `resolveInfraHandler(service, workspaceHandlers,
userOverrides)` — per-user override wins; `infraless` → `none` engine; pinned `custom`
  matches by key or `acceptsManifestId`; bare `custom` resolves only when unambiguous (else
  `type-mismatch`). Unit-tested.
- `environment-backends.ts`: optional `engines()`/`acceptsManifestIds()` on the provider +
  a `byEngine()` lookup. Built-ins declare engines (kubernetes → `local-k3s` +
  `remote-kubernetes`, compose → `local-docker`, manifest → `remote-custom`).
- `custom-manifest-types.ts`: app-owned `CustomManifestTypeRegistry` +
  `aggregateCustomManifestTypes` (merge registered + workspace rows, dedupe by `manifestId`).
- Kernel re-exports the new provision-type contract types.

### Slice 2b — reshape `environment_connections` + service consumption (TODO — breaking)

- **Persistence**: rekey `environment_connections` to `(workspace_id, provision_type,
coalesce(manifest_id,''))`; columns `provision_type`, `manifest_id`, `engine`,
  `accepts_manifest_id` (replace `kind`); keep `provider_id/label/base_url/handler_json
(was manifest_json)/secrets_cipher/created_at/deleted_at`. Clean `DROP/CREATE` D1
  migration + Drizzle schema edit + `db:generate`. Kernel port → multi-row API
  (`listByWorkspace` batched, `getByWorkspaceAndType`, `upsert`, `softDelete(ws, type,
manifestId, at)`). Rewrite the D1 + Drizzle connection repos. Extend the conformance
  suite to cover the reshaped connection repo.
- **`EnvironmentConnectionService`** → handler-aware: `listHandlers(ws)` (batched),
  `registerHandler(ws, {provisionType, engine, config, secrets})`, `updateSecrets(ws, type,
manifestId, secrets)`, `resolveProviderForType(ws, serviceProvisioning, userOverrides?)`
  (two batched reads → `resolveInfraHandler` → build via `registry.byEngine`, **merging the
  service `manifestSource`**), `unregisterHandler(ws, type, manifestId)`, custom-type CRUD.
  `describe`/`test`/`validate`/`bootstrap` take a `provisionType`/`manifestId` selector.
- **`EnvironmentProvisioningService.provision`**: accept the service's `provisioning` (+
  local `userId`); call `resolveProviderForType`; short-circuit `infraless`. (Recording the
  resolved type/engine is slice 3.)
- **Tester collapse** (`tester-infra.logic.ts`): drop the `defaultTestEnvironment` branch;
  the only start-time check is `infraless` (run no-infra) OR a handler resolves for the
  service's type (else refuse `provision-type-unhandled`). Remove `defaultTestEnvironment`
  from the `Block` contract + the block mapper + both runtimes' block columns + the frontend
  Block type. (Persisting `Block.provisioning` itself — block columns/JSON + mapper, D1 ⇄
  Drizzle + a round-trip conformance assertion — lands here too, since the service-view UI
  depends on it.)
- Update the env **controller** + the **conformance** fake-provider injection to the
  reshaped service API (the controller's per-type endpoint redesign can also be deferred to
  slice 4, but it must compile here).

### Slice 3 — engine step + run-details recording (TODO)

- `RunDispatcher.runDeployerStep`: resolve the service frame's `provisioning`, pass it (+
  the run-initiator `userId` in local mode) into `provision`; on `infraless` record a no-op
  step output; add `Provision type:` / `Engine:` lines + `model:
environment:<engine>:<providerId>`. Record `provisionType`/`engine` on the
  `EnvironmentRecord` (both the success and failed-env paths) so the handle carries them.

### Slice 4 — controllers + container wiring (TODO)

- `EnvironmentController`: per-type routes (`GET …/environments/handlers` batched bundle
  incl. the custom-type catalog; `POST …/handlers`; `PATCH …/handlers/:provisionType/secrets`;
  `DELETE …/handlers/:provisionType`); `describe`/`test`/`validate`/`bootstrap` gain
  `provisionType`/`manifestId`; custom-type CRUD (`…/environments/custom-types/:manifestId`).
- NEW `EnvironmentUserHandlerController` — **local-mode only**, mounted at ROOT (no
  `/workspaces` prefix), mirroring `LocalModelEndpointController` (401 w/o user; 503 where
  unwired): `GET/PUT/DELETE /me/environment-handlers/:workspaceId/:provisionType`. Mount in
  `@cat-factory/server` `app.ts`.
- Wire all THREE facade containers (`runtimes/cloudflare/src/infrastructure/container.ts`,
  `runtimes/node/src/container.ts`, `runtimes/local/src/container.ts`): the reshaped
  connection repo + the new `environment_user_handlers` + `custom_manifest_types` repos into
  `CoreDependencies`; local facade additionally wires the per-user override
  service/controller and threads the run-initiator `userId`.

### Slice 5 — frontend (TODO)

- **Service view** (`components/panels/inspector/ServiceTestConfig.vue`): a provisioning
  section — provision-type selector + per-type source inputs (kubernetes: colocated path OR
  **separate repo**, reuse `RepoTreeBrowser`; docker-compose: compose path + localDevOnly;
  custom: pick a `manifestId` from the catalog). Remove the local/ephemeral toggle. Writes
  `board.updateBlock(block.id, { provisioning })`. **Auto-detect** at add-service (extend the
  existing compose autodiscovery to also detect k8s manifests/kustomization), non-binding.
  `~/types/domain` `Block` gains `provisioning`, loses `defaultTestEnvironment`.
- **Infra view** (`components/settings/InfrastructureWindow.vue` +
  `InfrastructureBackendPicker.vue`): a per-provision-type configurator (one section per type)
  with an engine picker revealing the matching connect form (reuse `ProviderConnectionTab`);
  the remote-custom section declares its `acceptsManifestId`; a custom-manifest-type editor
  (list registered + workspace types, add/edit workspace ones); a local-mode per-user-override
  affordance writing to the user-handler endpoints.
- **Run details** (`components/environments/EnvironmentStatusPanel.vue`,
  `components/panels/StepMetadataCard.vue`): provision type + engine/provider lines from the
  handle's new fields; `~/types/execution` `RunEnvironment` gains them.
- **Stores** (`stores/providerConnections.ts` + a `stores/infraConfig.ts`) + **i18n**
  (`inspector.testConfig.provision.*`, `settings.infrastructure.engine.*`,
  `settings.infrastructure.customType.*`, `environments.provisionType`/`environments.engine`,
  `provision-type-unhandled`).

---

## Verification (per slice)

- `pnpm typecheck` (full-tree turbo) + `pnpm lint:fix` (whole tree, bare `.` target).
- `pnpm db:generate` must produce a committed Drizzle migration matching each D1 migration
  (`pnpm db:check` clean — no lineage drift).
- The `environment-handlers` conformance suite runs under BOTH `runtimes/cloudflare/test/`
  (real local D1 in workerd) and `runtimes/node/test/` (real Postgres via `DATABASE_URL`).
- Pure-logic unit tests: `infra-handler.logic.test.ts`; the reworked `tester-infra.logic`
  matrix (slice 2b).
- A changeset on every slice that touches a versioned package.

---

## Status checklist

| #   | Slice                                                                                                                                                                                                    | Status | PR   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 1   | Contracts (additive) + new tables (`environment_user_handlers`, `custom_manifest_types`) + `environments` columns + ports + repos + conformance                                                          | done   | #504 |
| 2a  | Resolver (`infra-handler.logic`) + registry `engines()`/`byEngine` + custom-type registry seam                                                                                                           | done   | #504 |
| 2b  | Reshape `environment_connections` (single→multi) + `EnvironmentConnectionService`/`ProvisioningService` reshape + `tester-infra` collapse (drop `defaultTestEnvironment`) + persist `Block.provisioning` | todo   | —    |
| 3   | `runDeployerStep` merge source+engine + record provisionType/engine; infraless no-op                                                                                                                     | todo   | —    |
| 4   | Controllers (per-type endpoints + custom-type CRUD + local-only per-user controller) + all three container wirings                                                                                       | todo   | —    |
| 5   | Frontend (service provisioning section + auto-detect; infra per-type/engine configurator + custom-type editor + local override; run-details surfacing; stores; i18n)                                     | todo   | —    |

Update the row (status + PR link) at the end of each slice.

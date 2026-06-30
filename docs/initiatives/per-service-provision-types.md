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

### Slice 2b — reshape `environment_connections` + handler-aware service (DONE — breaking)

Implemented as the FINAL data model + service API, with a **compat bridge** so the existing
controller/contracts/frontend stay green (per the requester: "build the final best, then
bridge between final best and current"). The tester collapse — a ~40-file behavioral
migration (`defaultTestEnvironment`/`tester.environment` removal) that the bridge lets us
keep unchanged — is split out into **slice 2c** below.

- **Persistence (done)**: rekeyed `environment_connections` to `(workspace_id, provision_type,
manifest_id)`; columns `provision_type`, `manifest_id`, `engine`, **`backend_kind`** (the
  registry kind that builds the provider — needed because several backends can share an engine,
  e.g. custom backends on `remote-custom`), `accepts_manifest_id`, `handler_json` (was
  `manifest_json`). Clean `DROP/CREATE` D1 migration `0025` + Drizzle schema + hand-authored
  migration (snapshot via `rebase-migration-snapshot.mjs`, `db:check` clean). Kernel port →
  multi-row API (`listByWorkspace`, `getByWorkspaceAndType`, `upsert`, per-type `softDelete`).
  D1 + Drizzle connection repos rewritten; conformance extended with reshaped-connection-repo
  assertions.
- **`EnvironmentConnectionService` (done)** → handler-aware: `listHandlers`, `registerHandler`,
  `updateHandlerSecrets`, `unregisterHandler`, custom-manifest-type CRUD, and
  `resolveProviderForType(ws, serviceProvisioning, userOverrides?)` (batched `listByWorkspace`
  → `resolveInfraHandler` → build via `requireBackend(backendKind)`, **merging the service
  `manifestSource`** into the kube engine config). The pre-reshape single-connection surface
  (`register`/`getConnection`/`describeProvider`/`updateSecrets`/`unregister`/`resolveProvider`
  /`requireConnection`/`resolveSecrets`/`validate`/`bootstrap`) is preserved as a thin BRIDGE
  over the primary handler.
- **`EnvironmentProvisioningService.provision` (done)**: accepts the service's `provisioning`;
  resolves per-type via `resolveProviderForType`; rejects `infraless`. (Recording the resolved
  type/engine onto the env record is slice 3; the local run-initiator `userId` override is slice 4.)
- **Controller + conformance (done)**: unchanged HTTP surface, now served by the bridge — the
  controller compiles + the existing conformance provisioning tests pass over the new table. A
  new `provision_type_unhandled` conflict reason was added (contracts + SPA title map).

### Slice 2c — tester collapse (drop `defaultTestEnvironment`) (DONE)

Implemented. The per-task/per-service `local`↔`ephemeral` toggle is gone; the Tester's infra is
driven entirely by the service's declared `provisioning`.

- **Tester gate** (`tester-infra.logic.ts` + `ExecutionService.assertTesterInfraConfigured`): the
  pure `decideTesterInfra` now takes `{ provisionType, localTestInfraSupported, handlerResolves }`
  — `infraless`/undeclared → pass (no infra); `docker-compose` → pass only on a DinD-capable
  runtime (else `tester_infra_unsupported` "limited mode"); `kubernetes`/`custom` → pass only when
  a workspace handler resolves (`provision_type_unhandled`). The gate resolves the handler lazily
  via the new `EnvironmentProvisioningService.canProvision` →
  `EnvironmentConnectionService.resolveHandlerForType` (pass-through when the provisioning seam is
  unwired). `resolveTesterEnvironment` is deleted.
- **Removed** `defaultTestEnvironment` / `testComposePath` / `noInfraDependencies` from the `Block`
  contract + `updateBlock` request, the shared block mapper, and both runtimes' block columns
  (D1 `0026_drop_tester_env_columns.sql` ⇄ Drizzle `20260630150445_medical_ikaris`, `db:check`
  clean). The agent-executor port `service` carries `provisioning` instead. The agent-context
  materialisation of `tester.environment` is gone.
- **Removed** the `tester.environment` agent-config descriptor (`@cat-factory/agents`);
  `testerEnvironmentSection` + `testerInfraSpec` now read the service's `provisioning.type` (the
  harness `infra` wire shape is unchanged — no image bump). The `tester.environment` doc-comment
  examples were repointed to `playwright.e2eTarget`.
- **Removed** the `delegateTestEnvToProvider` workspace setting (+ D1/Drizzle column,
  `WorkspaceSettingsService`, both settings repos) and the local-facade
  `resolveTesterFallbackDefault` / `resolveRequireEnvironmentProvider` wiring (+ the obsolete
  `tester-default.spec.ts`). The `InfrastructureBackendPicker` `testEnv` axis is now
  registration-driven (no delegate toggle) until slice 5's per-type configurator.
- **Frontend**: `ServiceTestConfig.vue` replaces the local/ephemeral toggle + compose/no-infra
  fields with a provision-type selector (+ compose path for `docker-compose`), writing
  `block.provisioning`; `TaskAgentConfig.vue` dropped the `tester.environment` service-default
  inheritance. New `inspector.testConfig.provision*` i18n keys across all 8 locales.
- **Conformance**: the tester-gate tests now assert the `infraless`/undeclared pass-through; the
  agent-config round-trip test uses `playwright.e2eTarget`; the workspace-settings test pairs
  `delegateAgentsToRunnerPool` with `kaizenEnabled`. The `Block.provisioning` round-trip assertion
  from slice 1 stays.

### Slice 3 — engine step + run-details recording (DONE)

- `RunDispatcher.runDeployerStep`: resolves the service frame's `provisioning` (walks up to the
  frame), passes it (+ the run-initiator `instance.initiatedBy`) into `provision`; on `infraless`
  records a no-op step output (`model: environment:none`); an UNDECLARED service falls through to
  the legacy single-connection path (the compat bridge), so existing workspaces keep provisioning.
  Adds `Provision type:` / `Engine:` lines + `model: environment:<engine>:<providerId>`.
- `EnvironmentProvisioningService`: `ProvisionArgs` gains `initiatedBy` + a
  `resolveUserHandlerOverrides` dependency seam (unwired ⇒ no per-user override). `provision`
  captures the resolved `provisionType`/`engine` and records them on the `EnvironmentRecord` on
  BOTH the success and failed-env (`persistFailedEnvironment`) paths. The registry repos already
  map the columns (slice 1), so the handle carries them runtime-symmetrically.
- Conformance: an `infraless` deployer no-op asserted on every facade; unit tests for the per-type
  record fields + the `initiatedBy`→override threading.

### Slice 4 — controllers + container wiring (DONE)

- `EnvironmentController`: per-type routes DONE (`GET …/environments/handlers` batched bundle
  incl. the custom-type catalog; `POST …/handlers`; `PATCH …/handlers/:provisionType/secrets`;
  `DELETE …/handlers/:provisionType`); custom-type CRUD DONE
  (`PUT|DELETE …/environments/custom-types/:manifestId`). **DEFERRED to slice 5**: the per-type
  `provisionType`/`manifestId` params on `describe`/`test`/`validate`/`bootstrap` — these stay on
  the compat-bridge primary handler for now and are the frontend's concern when the per-type
  configurator lands; the existing bridge endpoints keep working.
- NEW `EnvironmentUserHandlerController` — **local-mode only**, mounted at ROOT (no
  `/workspaces` prefix), mirroring `LocalModelEndpointController` (401 w/o user; 503 where
  unwired): `GET /me/environment-handlers/:workspaceId` (batched LIST — maps to the repo's
  `listByUserWorkspace`, slightly broader than the planned per-type GET) + `PUT|DELETE
…/:workspaceId/:provisionType`. Mounted in `@cat-factory/server` `app.ts`. Backed by the new
  `EnvironmentUserHandlerService` (integrations).
- Wiring: `customManifestTypeRepository` wired on ALL THREE facades (workspace catalog CRUD is
  runtime-neutral); `environmentUserHandlerRepository` wired ONLY on the local facade. The
  per-user override SERVICE + the `resolveUserHandlerOverrides` provisioning seam are built in the
  shared `createEnvironmentsModule` gated on that repo's presence — so "only the local facade
  wires the service" is enforced purely by which facade wires the repo (no runtime branch in
  shared code). The run-initiator `userId` is threaded via `instance.initiatedBy` (slice 3).
- **Decision (no migration):** the per-user override's `backendKind` is re-derived from its engine
  via the backend registry's `byEngine` (the per-user table is local-only, where each engine maps
  1:1 to a backend) rather than adding a `backend_kind` column to `environment_user_handlers` — so
  slice 4 adds NO migration. The shared `buildInfraHandlerFields` helper validates/lowers a handler
  config for both the workspace and per-user stores.

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

## Phase 2 — Kustomize / Helm / Gateway-API rendering (slices 6–10)

Goal: deploy a real Kustomize + Helm + Gateway-API setup (a `base/` + `overlays/` kustomize
tree, a Helm-installed gateway controller, `HTTPRoute`/`Gateway` routing, and a `secretGenerator`
fed from secrets — a common production ephemeral-environment shape). The native in-Worker REST
adapter applies only
raw, apiserver-ready manifests, so rendering moves into a **dedicated deploy container** with real
`kubectl`/`kustomize`/`helm`, dispatched through the existing runner transport as a new `deploy`
kind (with `image: 'deploy'`). The raw-manifest REST path is kept for the simple case; a service
selects by the `renderer` discriminator. Local mode adds an opt-in native-CLI transport
(`LOCAL_DEPLOY_RUNTIME=native|container`) that shells out to host `kubectl`/`kustomize`/`helm`.
Rationale for real binaries over an in-process JS renderer: kustomize `secretGenerator` rewrites a
content-hash secret-name suffix into every reference at build time, so the real secret must be
present at render time; helm is infeasible to render in-process. Slices 7–10 depend on slice 3
(`runDeployerStep`), which hosts the async-deployer lifecycle.

### Slice 6 — render contracts + dispatch/port seam (additive; NO migration) — DONE

The rare slice with NO `db:generate` migration: every addition is nested JSON inside the existing
`handler_json` / service `provisioning` TEXT columns.

- Contracts (`environments.ts`): `renderer: 'raw' | 'kustomize'` on `kubernetesManifestSourceSchema`;
  new `kubernetesImageOverrideSchema` / `kubernetesHelmReleaseSchema` (+ `*HelmSetSchema`) /
  `kubernetesSecretInjectionSchema` (+ `*SecretEntrySchema`); `images`/`helmReleases`/
  `secretInjections` on the SERVICE `serviceProvisioningSchema`; shared `helmReleases` on the
  WORKSPACE `kubernetesEngineConfigSchema`; `gatewayStatus`/`httpRouteStatus` URL sources.
- **Custom-named overlays + the dedicated-overlay ephemeral-env shape are first-class.** The
  overlay is identified purely by the free-form `manifestSource.path` (e.g. `…/overlays/<env>`),
  so its name carries no meaning. Two mechanics common to a dedicated ephemeral-env overlay are
  modelled: (1) the secret injection's `generatorEnvFile` mode writes the resolved `.env` at the
  path the overlay's OWN `secretGenerator` reads (vs colliding by materializing a duplicate
  `Secret`); (2) `namespaceTemplate` is honored as "absent ⇒ keep the overlay's pinned namespace
  (a shared, fixed-namespace env); set ⇒ override for per-PR isolation" — so a shared-namespace
  redeploy and a per-PR namespace are both expressible.
- Kernel port seam: `RunnerDispatchKind` → `'agent' | 'deploy'`; `RunnerDispatchOptions.image` →
  `+ 'deploy'`; `EnvironmentProvider.asyncProvision?` (the paired `buildProvisionJob`/`finalizeProvision`
  capability, grouped so neither can be implemented without the other) + `DeployProvisionJob`.
- Conformance: a kustomize/helm/gateway-shaped handler config round-trips write→read on D1 + Postgres
  (`environment-handlers-suite.ts`).

### Slice 7 — deploy-harness package + image (DONE)

`backend/internal/deploy-harness` (private): slim base + `kubectl`/`kustomize`/`helm` + the job-registry
scaffolding mirrored from `executor-harness`; same `POST /jobs` + `GET /jobs/{id}` contract (+ optional
`x-harness-secret` gate) with a `deploy` `KindEntry`; `handleDeploy` (clone → ensure namespace → write
`secretInjections`: a `Secret` resource OR a `generatorEnvFile` `.env` into the overlay tree →
`kustomize edit set namespace` when `setNamespace` overrides + `kustomize edit set image` for the
image overrides → install `scope: 'shared'` helm releases → `kubectl apply -k|-f` → per-environment
helm releases → `kubectl rollout status` → discover the env URL from Gateway/HTTPRoute/Service/Ingress
status). Returns a structured `DeployOutcome` (`namespace`/`url`/`status`) on the job result's `custom`
channel for slice 8's `finalizeProvision` to map. Every templated/secret value arrives ALREADY RESOLVED
in the job body (the backend resolves against the workspace bundle before dispatch) — the harness never
touches the bundle; the apiserver + git tokens live only for the job and are scrubbed from any output.

Shipped alongside: pure-logic unit tests (`job`/`url`/`deploy`/`kubeconfig`), a manual
`scripts/publish-image.sh` + a multi-arch `publish-deploy` job in `docker-publish.yml` (gated on the
deploy-harness paths), a `deploy/backend` `image:publish:deploy` target, and a changeset.

**Deferred to slice 10 (kept green):** the actual CF `[[containers]]` wrangler block + its Durable
Object container class. A `[[containers]]` entry that names a non-existent DO class fails the deploy,
and that DO class IS the `image: 'deploy'` → container-class mapping that slice 10 ("facade wiring")
owns. So slice 7 ships the IMAGE + its publish plumbing + the publish-target tag; the wrangler binding

- transport mapping land with the facade wiring.

### Slice 8 — provider render path + Gateway URL (DONE)

Implemented. `KubernetesEnvironmentProvider` now exposes the `asyncProvision` capability and the
native REST status path resolves Gateway-API URLs.

- **`asyncProvision.buildProvisionJob`** returns a `deploy`-kind job (`image: 'deploy'`) when the
  config needs rendering (`needsContainerRender`: `renderer: 'kustomize'`, or any helm release /
  image override / secret injection), else `null` (the synchronous REST `provision()` path for
  plain raw manifests). The pure spec builder (`kubernetes-deploy.logic.ts`) renders every template
  - resolves every `secretRef` backend-side, mirroring the harness's `DeployJob` shape (duplicated,
    not imported, so the backend never depends on the private deploy-harness package). `setNamespace`
    is set only for a kustomize source WITH a `namespaceTemplate` (per-PR isolation); absent ⇒ honor
    the overlay's namespace — the harness reads the namespace the built manifests actually declare and
    ensures / monitors / reports / tears down THAT namespace (`resolveTargetNamespace` +
    `extractManifestNamespace`, deploy-harness image `0.2.2`), never a stray per-PR default. Throws if
    rendering is needed but the engine supplied no deploy inputs, or if the cluster `apiToken` is unset.
- **`asyncProvision.finalizeProvision`** maps the harness `DeployOutcome` (on `view.result.custom`)
  → `ProvisionedEnvironment`; a failed view becomes a `failed` env carrying the harness error.
- **Native REST `status()`** gained `gatewayStatus` (prefer a concrete listener hostname over the
  assigned `.status.addresses[]` value, skip wildcards) and `httpRouteStatus` (the route's own
  hostname, else the parent Gateway's address read in the parentRef's namespace) URL resolvers,
  mirroring the deploy-harness `url.ts` logic over the apiserver REST client. Teardown unchanged.
- **Contracts**: `kubernetesProvisionConfigSchema` (the combined config + render inputs) is what the
  deploy adapter consumes (`EnvironmentBackendConfig.kubernetes` now references it).
  `EnvironmentConnectionService.handlerConfigToBackendConfig` merges the service's render inputs
  (images / per-env helm releases / secret injections) with the workspace engine config (shared helm
  releases) — alongside the existing `manifestSource` merge.
- **Kernel**: `DeployCloneTarget` + `DeployProvisionInputs` (clone coords + token + job ref) on
  `ProvisionEnvironmentRequest`, populated by the provisioning service in slice 9.
- **NOT wired yet**: nothing dispatches a deploy job — the provisioning-service `provision()` branch
  on `buildProvisionJob` + the `runDeployerStep` park/poll is slice 9. Tested as unit/mocked-fetch
  (`kubernetes-deploy.logic.test.ts`, `KubernetesEnvironmentProvider.test.ts`); no migration (the
  render fields ride existing JSON), so no conformance/D1⇄Drizzle change.

### Slice 9 — async deployer lifecycle (DONE; folds into slice 3)

Implemented. The deployer can now stand an environment up in a CONTAINER (real
`kubectl`/`kustomize`/`helm`) via dispatch → park → poll → finalize, alongside the unchanged
synchronous in-Worker REST path.

- **`EnvironmentProvisioningService` (done)**: gains the async lifecycle next to `provision()`.
  `startProvision(args, ref)` resolves the provider and either provisions SYNCHRONOUSLY (raw
  manifests → a final `completed` handle) or, when `provider.asyncProvision.buildProvisionJob`
  returns a job, dispatches a `deploy`-kind job via the new `deployJobClient`, persists a
  `provisioning` env record, and returns `dispatched` with the job ref. `pollProvisionJob` polls
  the deploy view; `finalizeProvision` maps a terminal view → the env record (a failed view → a
  `failed` env carrying the harness error, superseding the dispatch-time `provisioning` row);
  `releaseProvisionJob` reclaims the runner. Two new optional deps: `deployJobClient` (typed
  structurally as `DeployJobClient`, so integrations stays runtime-neutral; the facade passes its
  `RunnerJobClient`) and `resolveDeployCloneTarget` (the VCS-specific manifests-repo clone target
  the stateless provider can't derive). The shared `provision()` internals were extracted
  (`resolveProvision` / `buildProvisionRequest` / `provisionSync` / `recordProvisioned` /
  `captureProvisionFailure`) so the sync + async paths can't drift.
- **`RunDispatcher` (done)**: `runDeployerStep` dispatches via `startProvision` and parks on
  `awaiting_job` for an async job (re-attaching on replay via `step.jobId`); a new
  `pollDeployerJob` branch in `pollAgentJob` drives the deploy poll — live container/subtask
  progress while running, container-eviction recovery by re-dispatching a fresh deploy job within
  the same budgets as the agent path, and finalize-into-step-result on a terminal view. Extracted
  `completeDeployerStep` + `deployerProvisionArgs`; the infraless no-op + legacy fallback are
  unchanged.
- **Wiring (done)**: `CoreDependencies` threads `deployJobClient` + `resolveDeployCloneTarget`
  into `createEnvironmentsModule` (optional). Both runtimes share the identical (unwired)
  behaviour — nothing dispatches a deploy job until slice 10 wires the facade transport +
  clone-target resolver. Unit-tested with fakes (dispatch / poll / finalize success+failure /
  unwired-transport / sync fallback); the existing deployer conformance (failure surfacing,
  infraless no-op) still passes over the unchanged synchronous path.

### Slice 10 — facade wiring + local native CLI (DONE)

Implemented. Slice 9's `deployJobClient` / `resolveDeployCloneTarget` seams are now wired on every
facade, so a render-needing `deployer` step stands its environment up in a real deploy container (or,
locally, the host CLIs). The raw-manifest REST path is unchanged.

- **Cloudflare** (`runtimes/cloudflare`): a new per-run `DeployContainer` Durable Object (the
  deploy-harness image — `kubectl`/`kustomize`/`helm`), the container class deferred from slice 7. It
  mirrors `ExecutionContainer` (rollout-aware, `shutdown`) and is bound as `DEPLOY_CONTAINER`, with a
  `[[containers]]` block + binding + a `v4` `new_sqlite_classes` migration in BOTH wranglers
  (`runtimes/cloudflare` test config → the deploy-harness Dockerfile; `deploy/backend` prod config →
  the managed-registry `cat-factory-deploy:0.2.2` tag from slice 7) and the class exported from the
  worker entry. `CloudflareContainerTransport` is widened to accept either container namespace; the
  `image: 'deploy'` dispatch routes to `DEPLOY_CONTAINER` (agent jobs stay on `EXEC_CONTAINER`).
  `selectDeployDeps` wires a deploy-DEDICATED `RunnerJobClient` (over the deploy namespace, no
  instance registry — `sleepAfter`/`release` reclaim it) + `resolveDeployCloneTarget`, gated on the
  binding + GitHub App.
- **Node** (`runtimes/node`): the default `deployJobClient` is `new RunnerJobClient(resolveTransport)`
  — Node deploys on the workspace's self-hosted runner pool, the analogue of the Worker's
  DeployContainer — plus a `resolveDeployCloneTarget` from the App token mint. Both are injectable
  (`buildNodeContainer` options) so the local facade overrides them, and a
  `disableDefaultDeployJobClient` flag stops the agent transport backing deploy (it lacks the k8s
  CLIs). The pool now forwards the `image` dispatch option: the generic `RunnerPoolTransport` stamps
  it onto the spec and `HttpRunnerPoolProvider` exposes it as a first-class `{{input.image}}`
  variable, while the native Kubernetes runner config gains an `imageDeploy` variant (`resolveImage`).
- **Local** (`runtimes/local`): a new `NativeCliDeployTransport` selected by
  `LOCAL_DEPLOY_RUNTIME=native|container`. `native` (default) runs the deploy harness as a host
  process (the `LocalProcessRunnerTransport` machinery, `LOCAL_DEPLOY_HARNESS_ENTRY`) driving the
  developer's own `kubectl`/`kustomize`/`helm`; `container` runs `LOCAL_DEPLOY_IMAGE` per job through
  a `JobScopedRunnerTransport` wrapper that re-keys the deploy job by its OWN `jobId` so its container
  never collides with the run's agent `ExecutionContainer`. Unwired ⇒ deploy stays off (render
  configs fail loudly). The clone target is inherited from Node's default (the local PAT mint +
  GitLab-aware `resolveRepoOrigin`).
- **Shared** (`@cat-factory/server`): exports `makeResolveDeployCloneTarget` (compose a clone-target
  resolver from a repo-target walk + token mint, with an optional per-facade clone-URL override).
  Fixed a latent bug in `RunDispatcher.completeDeployerStep`: the async deploy SUCCESS path now
  re-attaches the step's environment projection, so a finalized env shows `ready` + its URL instead of
  the stale `provisioning` snapshot stamped at park time (the failure path already re-attached).
- **Conformance**: a new shared assertion drives the full container render path on both runtimes —
  inject a fake provider with `asyncProvision` + a fake `deployJobClient` + `resolveDeployCloneTarget`,
  run a `deployer` pipeline, and assert the engine dispatched a `deploy`-kind job carrying the
  `image: 'deploy'` variant AND the stubbed terminal view finalized to an identical
  `ProvisionedEnvironment` (D1 ⇄ Postgres). Threaded through all three facade harnesses' overrides.
- **No image-tag bump**: the deploy-harness payload (`src/**`/`Dockerfile`/`PI_*`) is untouched, so
  the `cat-factory-deploy:0.2.2` image from slice 7 is reused as-is.

### Slice 11 — auto-detect a RECOMMENDED k8s config from the repo (TODO)

Extend the add-service auto-detect (slice 5) from "which provision type" to "propose a full,
NON-BINDING recommended `kubernetes` config", read checkout-free over the existing `RepoFiles`
port (a pure-TS heuristic detector — no checkout, no LLM for the high-confidence parts; mirror the
existing compose autodiscovery). The user always confirms/edits; nothing is applied silently.
What's inferable, by confidence:

- **High confidence (deterministic):** `renderer` (`kustomization.yaml` present ⇒ `kustomize`, else
  `raw`); the URL source from manifest kinds (`Ingress` ⇒ `ingressStatus`/`ingressTemplate` from a
  static host, `Gateway`/`HTTPRoute` ⇒ `gatewayStatus`/`httpRouteStatus`, `Service type:
LoadBalancer` ⇒ `serviceStatus`); the namespace decision (a pinned `namespace:` ⇒ recommend
  honoring it, leave `namespaceTemplate` empty); `secretInjections` in `generatorEnvFile` mode when
  a `secretGenerator: { envs: ['.env'] }` exists, with the entry KEYS read from a checked-in
  `.env.example` (values stay the user's); `images` override candidates from the kustomization
  `images:` block or Deployment container images (default `newTagTemplate: '{{branch}}'`).
- **Lower confidence (surface candidates, don't auto-pick):** WHICH overlay is the ephemeral one
  when several exist under `overlays/*` (rank by name — `prenv`/`preview`/`pr`/`ephemeral`/`dev` —
  and let the user choose); helm releases declared parseably (`helmfile.yaml` / a `Chart.yaml`
  dependency) ⇒ propose `helmReleases`; a controller installed by a bespoke shell script / CI step
  is NOT reliably parseable ⇒ leave blank with a hint rather than guess.
- **Optional later:** an LLM `explore` pass (the read-only agent kind) for the ambiguous cases
  (pick the ephemeral overlay, infer helm intent from a deploy script), proposing the same config
  shape the deterministic detector emits — gated/non-binding, never silent.

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

| #   | Slice                                                                                                                                                                                                                                                                                                                                    | Status | PR   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 1   | Contracts (additive) + new tables (`environment_user_handlers`, `custom_manifest_types`) + `environments` columns + ports + repos + conformance                                                                                                                                                                                          | done   | #504 |
| 2a  | Resolver (`infra-handler.logic`) + registry `engines()`/`byEngine` + custom-type registry seam                                                                                                                                                                                                                                           | done   | #504 |
| 2b  | Reshape `environment_connections` (single→multi, `backend_kind`) + handler-aware `EnvironmentConnectionService` (`resolveProviderForType` w/ manifestSource merge) + `ProvisioningService` per-type + compat bridge + conformance                                                                                                        | done   | #510 |
| 2c  | Tester collapse: drop `defaultTestEnvironment`/`tester.environment`/`resolveTesterEnvironment`; gate on `infraless` OR a resolved handler (`provision_type_unhandled`)                                                                                                                                                                   | done   | —    |
| 3   | `runDeployerStep` merge source+engine + record provisionType/engine; infraless no-op                                                                                                                                                                                                                                                     | done   | —    |
| 4   | Controllers (per-type endpoints + custom-type CRUD + local-only per-user controller) + all three container wirings (describe/test/validate/bootstrap per-type params deferred to slice 5)                                                                                                                                                | done   | —    |
| 5   | Frontend (service provisioning section + auto-detect; infra per-type/engine configurator + custom-type editor + local override; run-details surfacing; stores; i18n)                                                                                                                                                                     | todo   | —    |
| 6   | Phase 2: render contracts (`renderer`/`images`/`helmReleases`/`secretInjections`/gateway URL) + dispatch/port seam (`deploy` kind + `image`, `buildProvisionJob`/`finalizeProvision`); NO migration; conformance round-trip                                                                                                              | done   | —    |
| 7   | Phase 2: `deploy-harness` package + image (kubectl/kustomize/helm; `deploy` KindEntry + `handleDeploy`; publish plumbing + tag). CF container class/binding deferred to slice 10 (needs the DO class)                                                                                                                                    | done   | —    |
| 8   | Phase 2: `KubernetesEnvironmentProvider` render path (`buildProvisionJob`/`finalizeProvision`; keep native REST) + Gateway-API URL resolvers                                                                                                                                                                                             | done   | —    |
| 9   | Phase 2: async deployer lifecycle (`startProvision`/`pollProvisionJob`/`finalizeProvision`; `runDeployerStep` park/poll + eviction re-dispatch; `deployJobClient`/`resolveDeployCloneTarget` deps) — folds into slice 3                                                                                                                  | done   | —    |
| 10  | Phase 2: facade wiring (CF `DeployContainer` + `[[containers]]`/binding/`v4` migration; Node pool `image`/`imageDeploy`; local `NativeCliDeployTransport` via `LOCAL_DEPLOY_RUNTIME`) + `deployJobClient`/`resolveDeployCloneTarget` on all three facades; deploy-dispatch + finalize conformance. No image-tag bump (harness untouched) | done   | —    |
| 11  | Phase 2: auto-detect a recommended `kubernetes` config from the repo (renderer / URL source / namespace / secret `.env` keys / image overrides high-confidence; overlay choice + helm as candidates) — non-binding, user confirms                                                                                                        | todo   | —    |

Update the row (status + PR link) at the end of each slice.

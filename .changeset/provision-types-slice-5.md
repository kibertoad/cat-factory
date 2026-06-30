---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': patch
'@cat-factory/app': minor
---

Per-service provision types (slice 5): the frontend for the what/where ÷ how split.

- **Service provisioning section** (`ServiceTestConfig.vue`): the per-type source inputs a
  service owns (the "what/where"). Kubernetes now offers the manifest source (colocated path —
  browsable in-repo — or a separate repo + ref + path) and the renderer (raw / kustomize);
  custom pins a `manifestId` from the workspace catalog (+ an optional manifest path);
  docker-compose gains a "local development only" flag. Type switches merge onto the existing
  provisioning so each type's fields survive toggling.
- **Infrastructure configurator** (`InfraHandlersConfigurator.vue` in the Infrastructure
  window's environments tab): one section per provision type (the "how"). Kubernetes has an
  engine picker (local-k3s / remote-kubernetes) revealing the new `KubernetesEngineForm` (the
  apiserver + URL-derivation engine connection, split from the service-owned manifest source);
  docker-compose is informational (runs on the runtime's local Docker); custom hosts the
  `CustomManifestTypeEditor` (the open catalog — read-only registered types + editable
  workspace ones) plus a `remote-custom` HTTP handler per custom type. In local mode each kube
  handler also offers a personal (this-machine) override written to the `/me/environment-handlers`
  endpoints.
- **Run details**: `EnvironmentStatusPanel` now surfaces the resolved provision type + engine
  recorded on the environment handle. `runEnvironmentSchema` (`@cat-factory/contracts`) gains
  `provisionType`/`engine`, and `RunDispatcher.attachEnvironmentProjection` maps them from the
  handle onto the step's environment projection.
- **Stores/API**: a new `composables/api/infraHandlers.ts` wraps the slice-4 handler-bundle,
  per-type register/rotate/remove, custom-type CRUD, and the per-user override endpoints; a new
  `stores/infraConfig.ts` owns the handler + custom-type state (loaded on demand, never from the
  snapshot). New `inspector.testConfig.*`, `settings.infrastructure.kubernetesEngine.*` /
  `customType.*` / `handler.*` / `engine.*`, and `environments.provisionType.*` / `engine.*`
  i18n keys across all 8 locales.

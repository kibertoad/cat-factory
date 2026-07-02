# Initiative: registry DI migration (app-owned registries)

**Status:** in progress (pilot landed) · **Owner:** core · **Started:** 2026-06-30

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

The platform exposes ~11 plugin-style registries populated by **import side-effect into a
module-level `Map`** (`registerGate`, `registerAgentKind`, `registerRunnerBackend`, …).
That pattern is **brittle for externally-published adapter packages**: registration only
takes effect if the adapter and the server resolve the _same_ module instance of the
owning package. A third-party adapter that bundles its own copy registers into a phantom
`Map` and is invisible at runtime — the gotcha the "custom kinds" work (#472) exposed. The
module globals also force `clear*()` test cruft and process-wide shared state.

The fix: the **composition root owns each registry instance** and threads it through the
existing single `CoreDependencies` object. Modules contribute built-ins via a factory;
custom packages register **by reference** (`registry.register(provider)`). Module identity
stops mattering, the gotcha is gone, and tests get a fresh instance instead of `clear*()`.
This generalizes the two seams already built this way: `CompositeModelProvider`
(`@cat-factory/agents`) and `RegistryReleaseHealthProvider` (observability).

## Target pattern (the reference implementation)

The pilot — the environment-backend + runner-backend registries — is the template:

1. **Registry class** replaces the module `Map`: `RunnerBackendRegistry` /
   `EnvironmentBackendRegistry` (`backend/packages/integrations/src/modules/runners/runner-backends.ts`,
   `…/environments/environment-backends.ts`) with `register` / `get` / `kinds` / `labelled`
   methods (+ `findRepairCapable` on the env one). No bottom-of-file self-registration.
2. **`default*Registry()` factory** news a registry pre-loaded with the built-in kinds.
3. **Unified construction entry**: `createBackendRegistries()`
   (`backend/packages/integrations/src/modules/backend-registries.ts`) returns all of a
   module's registries — the single call a facade makes.
4. **Inject via `CoreDependencies`**: the registry is an (optional, defaulted) field on
   `CoreDependencies` (`backend/packages/orchestration/src/container.ts`), passed to the
   consuming service's constructor; the service reads `this.deps.<registry>.get(kind)`.
5. **Facades construct + inject**: each `build*Container` calls `createBackendRegistries()`
   (or accepts an injected one), spreads it into `CoreDependencies`, and also attaches the
   registry to the `ServerContainer` so a controller (e.g. the workspace snapshot's
   backend-kind selectors) can read it. **Keep the runtimes symmetric** — Worker + Node +
   local (local inherits via `buildNodeContainer`).
6. **Conformance assertion**: the cross-runtime suite injects a registry pre-loaded with a
   fake custom backend (via a `makeApp({ backendRegistries })` seam) and asserts it
   resolves identically on every runtime — replacing the old module-global registration.
7. **Changeset**: flag the removal of the old free `register*` exports as breaking.

## Per-registry checklist

| Registry               | Owning package                | File                                           | Status                                                                                              | PR      |
| ---------------------- | ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| Environment backends   | integrations                  | `modules/environments/environment-backends.ts` | ✅ done                                                                                             | (pilot) |
| Runner backends        | integrations                  | `modules/runners/runner-backends.ts`           | ✅ done                                                                                             | (pilot) |
| User-secret kinds      | integrations                  | `modules/providers/userSecretKinds.ts`         | ✅ done                                                                                             |         |
| Observability adapters | integrations                  | `modules/observability/registry.ts`            | ⚠️ partial (already injected into `RegistryReleaseHealthProvider`; uses a record, not a module Map) |         |
| Gates                  | kernel + `@cat-factory/gates` | `kernel/domain/gate-registry.ts`               | ⬜ todo                                                                                             |         |
| Provider tokens        | kernel                        | `domain/provider-registry.ts`                  | ⬜ todo                                                                                             |         |
| Step resolvers         | kernel                        | `domain/step-resolver-registry.ts`             | ⬜ todo                                                                                             |         |
| Pipelines              | kernel                        | `domain/pipeline-registry.ts`                  | ⬜ todo                                                                                             |         |
| VCS providers          | kernel                        | `domain/vcs-registry.ts`                       | ⬜ todo                                                                                             |         |
| Agent kinds            | agents                        | `agents/kinds/registry.ts`                     | ⬜ todo                                                                                             |         |
| Agent traits           | agents                        | `agents/kinds/traits.ts`                       | ⬜ todo                                                                                             |         |
| Model providers        | agents                        | `providers/registry.ts`                        | ✅ already instance-based (`CompositeModelProvider`)                                                |         |

## Conventions / gotchas carried between iterations

- **Keep the runtimes symmetric.** Every registry must be wired into Worker + Node (+ local
  inherits) in the SAME change, with a conformance assertion. A facade-parity gap is a
  showstopper, not a follow-up.
- **`CoreDependencies` IS the app-owned bag.** Don't invent a new aggregate type per
  registry; add a field (optional + defaulted to the `default*Registry()` so existing
  `CoreDependencies` construction sites — tests, harnesses — don't break).
- **Fresh instance per test, not `clear*()`.** Once a registry is injected, a test builds
  its own; delete the old `clear*()` calls as each registry migrates.
- **Watch for >1 construction site per facade.** A registry may be resolved both in the
  module factory (orchestration) AND in a facade helper that builds a service directly
  (e.g. `buildNodeResolveTransport` / the Worker `buildResolveTransport`). Thread the SAME
  instance to all of them. (User-secret kinds: the Worker builds a throwaway resolve-only
  `UserSecretService` for the PAT resolver AND the container-wired one — only the latter
  consults the kind registry, so the resolve-only sites can keep the default.)
- **A registry consumed only by an integrations service still rides `CoreDependencies`.**
  `UserSecretService` is built directly by each facade, not by `createCore`, so the
  `userSecretKindRegistry` field on `CoreDependencies` isn't read by the engine — it exists
  purely so each facade reads the SAME instance off `overrides` (the conformance injection
  seam) and threads it into the service. Also add it to `BackendRegistries` /
  `createBackendRegistries()` so Node destructures it from `options.backendRegistries`.
- **A rebuilt-container conformance probe must re-thread the override.** The Worker's
  `userSecrets` probe rebuilds a fresh `buildContainer(...)` for direct service access rather
  than reusing the `makeApp` container (Node reads `container.userSecrets` from the same
  build). That rebuild silently drops the injected registry unless you pass the override into
  it too — the custom-kind assertion is what catches the omission.
- **Pre-1.0 = no back-compat.** Remove the old free functions outright; flag breaking in
  the changeset. Don't keep a shim.
- **Agent-kind / pipeline / gate registries are read deep in the engine** (lazily, on first
  use). Migrating those means threading the registry into `ExecutionService` /
  `seedPipelines` — larger blast radius than the backend registries; scope each carefully.

## Out of scope for the pilot

The 9 remaining `todo` registries above. `@cat-factory/example-custom-agent` registers
agent-kinds/gates/pipelines (not backends), so it stays on the side-effect import until
those registries migrate — at which point its registration moves to an explicit
`register(registries)` call from the facade composition root.

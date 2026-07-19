---
'@cat-factory/kernel': minor
'@cat-factory/gates': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Move the **gate** and **step-resolver** registries onto the app-owned DI seam
(`docs/initiatives/registry-di-migration.md`), the same pattern as the agent-kind /
backend registries. The two engine-extension registries the `RunDispatcher` reads are no
longer module-global `Map`s populated by import side effect.

- **kernel** now exposes `GateRegistry` / `defaultGateRegistry()` and `StepResolverRegistry`
  / `defaultStepResolverRegistry()` classes. The free functions `registerGate` /
  `registeredGateFactories` / `clearRegisteredGates` and `registerStepResolver` /
  `registeredStepResolverFactories` / `clearRegisteredStepResolvers` are **removed**
  (breaking — pre-1.0, no shim). Registration is now `registry.register(kind, factory)` on
  the app-owned instance the composition root injects.
- **`@cat-factory/gates`** — `registerBuiltinGates(registry)` now takes the app-owned
  `GateRegistry` and the **module-load side-effect registration is gone** (the
  `registerBuiltinGates()` band-aid the registry-DI initiative called out). A new
  `gateRegistryWithBuiltins()` factory returns a fresh registry pre-loaded with the suite in one
  call — the seam a facade uses (`overrides.gateRegistry ?? gateRegistryWithBuiltins()`) so the
  empty-default hazard is unrepresentable; `registerBuiltinGates` stays for installing into an
  already-held instance.
- **orchestration** threads `gateRegistry` + `stepResolverRegistry` through
  `CoreDependencies` → `ExecutionService` → `RunDispatcher` (defaulted so existing
  construction sites don't break), re-exposes `gateRegistry` on `Core`, and
  `validateRegistrations` now takes the gate registry to cross-check.
- The three **facades** build the registries, install the built-in gates, and inject the
  same instance into `createCore` + the boot-time validation — kept symmetric and covered by
  the cross-runtime conformance suite (the custom-gate + step-resolver assertions now inject
  the registries via `makeApp`).

Provider tokens and the pipeline registry remain module-global (the next slices of the
initiative). Deployment packages that registered gates/resolvers via the free functions must
switch to registering by reference on the injected instances (see
`@cat-factory/example-custom-agent`'s `registerExampleCustomAgents`).

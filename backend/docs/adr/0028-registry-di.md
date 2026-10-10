# ADR 0028: App-owned plugin registries (registry DI migration)

- **Status:** Accepted (implemented)
- **Date:** 2026-07-24
- **Context layer:** backend (`@cat-factory/kernel`, `@cat-factory/agents`, `@cat-factory/integrations`, `@cat-factory/gates`, `@cat-factory/orchestration`, `backend/runtimes/*`)

## Context

The platform exposes ~12 plugin-style registries: gates, agent kinds, pipelines, VCS
providers, provider tokens, step resolvers, runner/environment backends, user-secret kinds,
initiative presets, agent traits, model providers, observability adapters. Historically each
was populated by an **import side-effect into a module-level `Map`** (`registerGate`,
`registerAgentKind`, `registerRunnerBackend`, …).

That pattern is brittle for externally-published adapter packages: registration only takes
effect if the adapter and the server resolve the _same_ module instance of the owning
package. A third-party adapter that bundles its own copy registers into a phantom `Map` and
is invisible at runtime: the gotcha the "custom kinds" work (#472) exposed, and the same
class of bug that made PR #783 go CI-red on the Cloudflare shard only when a conformance
`clearRegisteredAgentKinds()` wiped built-ins another test in the same module instance
needed (see ADR 0018). The module globals also forced `clear*()` test cruft and process-wide
shared state.

## Decision

The **composition root owns each registry instance** and threads it through the existing
single `CoreDependencies` object. Each module-global `Map` became a registry **class** with
`register` / `get` / `kinds` (+ registry-specific methods), paired with a `default*Registry()`
factory that news an instance pre-loaded with that module's built-ins (no module-load side
effect). Built-ins are contributed by the factory; a deployment teaches the platform a custom
entry **by reference** (it holds the same instance and calls `registry.register(...)`) so
module identity stops mattering and the phantom-`Map` hazard is gone. Every facade
(Cloudflare, Node, local) resolves `overrides.<registry> ?? default<Registry>()`, spreads it
into `CoreDependencies`, and, where a controller needs it, attaches it to the
`ServerContainer`; local inherits via `buildNodeContainer`. The free `register*` / `clear*`
exports were removed outright (pre-1.0, no shim; flagged breaking in the changesets).

Every registry named in the Context now follows this shape:

- **Integrations:** `RunnerBackendRegistry`, `EnvironmentBackendRegistry` (the pilot, unified
  behind `createBackendRegistries()`), `UserSecretKindRegistry`, and (the final slice) the
  `ObservabilityProviderRegistry` class + `defaultObservabilityRegistry()` factory (replacing
  the interim `Partial<Record<kind, factory>>` record injected into
  `RegistryReleaseHealthProvider`).
- **Kernel:** `GateRegistry` (built-ins live in `@cat-factory/gates`, so `defaultGateRegistry()`
  is empty and the gate package exposes `gateRegistryWithBuiltins()`), `StepResolverRegistry`,
  `ProviderRegistry` (read via `GateContext`), `PipelineRegistry` (`seedPipelines(registry?)`),
  `VcsProviderRegistry` (a **required** `ServerContainer` field, so parity is type-enforced),
  and the initiative-preset registry.
- **Agents:** `AgentKindRegistry` (ADR 0018), with agent **traits** folded onto it
  (`registry.registerTrait` / `assignTraits`) rather than a separate registry, and the
  already-instance-based `CompositeModelProvider`.

## Rationale

- **No shared process state, no `clear*()`.** An app-owned instance means a test (or a
  request) can never see another's registrations; the whole bug class disappears rather than
  being patched per call site. Tests build a fresh registry instead of clearing a global.
- **Provider tokens stayed a gate concern.** The kernel `ProviderRegistry` is read solely by
  the gate machine's `GateContext` (`getProvider` / `requireProvider` / `isProviderWired`); the
  integrations document/task services keep their own registries. A fresh instance per build
  starts empty, so the per-build `clearGateProviders` reset is gone.
- **Match conformance to blast radius.** Cross-runtime behaviour that can diverge got a
  conformance assertion (a custom backend/kind resolving identically on every runtime); VCS
  parity is instead **type-enforced** by the required `ServerContainer` field, and the
  observability slice is a straight shape normalization covered by the existing
  `RegistryReleaseHealthProvider` unit tests.
- **Threading over new carriers.** Registries ride the existing `CoreDependencies` bag as
  optional-defaulted fields rather than a new aggregate type per registry, and pure functions
  (`traitsFor`, `systemPromptFor`, …) take the registry as an explicit parameter so the
  domain/wire boundary stays clean.

## Consequences

- The extension seam is a breaking change: runtime `src/index.ts` entry points no longer
  re-export the free `register*` / `clear*` functions; a deployment injects a pre-loaded
  registry through the container / `start()` / `startLocal()` seams and registers custom
  entries by reference. `@cat-factory/gitlab` and `@cat-factory/example-custom-agent` register
  entirely by reference on the injected instances, with no module-global left.
- **Keep the runtimes symmetric** was the governing constraint: each registry, its facade
  wiring, and its conformance/type check landed together to avoid a facade-parity gap.
- **Deliberately not pursued:** the `SubscriptionQuotaRegistry` stays a plain record for now:
  it holds no built-ins to pre-load (its real-quota adapters land with a later executor-harness
  image bump), so it graduates to the class shape when its first adapter lands rather than
  churning an empty record early. Gate **providers** (the `wireX` handles) remain
  deployment-global by design; only the gate _registry_ migrated.

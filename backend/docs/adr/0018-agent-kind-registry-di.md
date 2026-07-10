# ADR 0018: App-owned AgentKindRegistry instances (remove the module-global agent-kind registry)

- **Status:** Accepted (implemented)
- **Date:** 2026-07-10
- **Context layer:** backend (`@cat-factory/agents`, `@cat-factory/orchestration`, `backend/runtimes/*`)

## Context

PR #783 (bug-triage phase F) went CI-red on the Cloudflare worker shard only — Node and
local passed. Root cause: the conformance suite's custom-agent/custom-gate `describe`
blocks call `afterEach(() => clearRegisteredAgentKinds())`, which cleared a
**module-global** `Map` in `@cat-factory/agents`. The built-in kinds (`bug-investigator`,
`document`, `initiative`) were registered only as a one-time import side effect and were
never restored after a clear. On the **worker**, the entire conformance suite runs in one
module instance, so a later test that needed a built-in kind found it gone. On **Node/local**
each conformance file is its own module, so the pollution never surfaced — a facade
asymmetry caused entirely by shared process state.

The gate registry already had a band-aid for this class of bug (`registerBuiltinGates()`
re-registers built-in gates after a clear). Extending that pattern to agent kinds would have
fixed the symptom but left the module-global registry — and the general external-adapter
module-identity hazard it creates — in place.

## Decision

Remove the module-global agent-kind registry entirely. `AgentKindRegistry` is now a class,
instantiated fresh per app via `defaultAgentKindRegistry()` (pre-loads the built-ins, no
module-load side effect). It rides `CoreDependencies` as its own optional field
(`agentKindRegistry?: AgentKindRegistry`), defaulted at the `ExecutionService` construction
boundary. Every pure prompt-building function that used to reach into module state
(`systemPromptFor`/`userPromptFor`/`traitsFor`/`traitGuidanceFor`/`agentTuningFor`/
`configContributionsFor`/`webResearchGuidanceFor`/`isInlineModelStep`) now takes the registry
as an explicit parameter, and every deps bag that dispatches or validates agent kinds
(`AiAgentExecutorDependencies`, `ContainerAgentExecutorDependencies`,
`ConsensusAgentExecutorDependencies`, `RunDispatcherDeps`, `ValidateRegistrationsOptions`,
`CompositeAgentExecutor`) carries the instance.

Each facade (Cloudflare, Node, local) resolves `overrides.agentKindRegistry ??
defaultAgentKindRegistry()`, spreads it into `CoreDependencies`, and attaches it onto the
`ServerContainer`; local shares the same instance into `buildNodeContainer`. The free
`registerAgentKind(s)`/`registered*`/`clearRegisteredAgentKinds` exports were removed
outright — a deliberate breaking change (pre-1.0, no shim) — in favour of injecting a
pre-loaded registry through the existing container/`start()`/`startLocal()` seams, mirroring
how a deployment already registers backend registries by reference.

## Rationale

- **No shared process state, no `clear*()`.** An app-owned instance means a test (or a
  request) can never see another test's registrations; the whole class of bug disappears
  rather than being patched per call site.
- **Consistent with the registry-DI migration's target pattern.** This slice mirrors the
  backend-registries pilot (`RunnerBackendRegistry`/`EnvironmentBackendRegistry`): composition
  roots own instances, nothing is a module global.
- **Threading over a new carrier.** The registry is passed as an explicit parameter through
  the pure functions rather than attached to `AgentRunContext` (a serialized kernel DTO, not a
  deps bag), keeping the domain/wire boundary clean.

## Consequences

- Both conformance `afterEach(() => clearRegisteredAgentKinds())` calls were deleted; custom-
  kind tests now new-up `defaultAgentKindRegistry()` and inject it via
  `makeApp(opts, { agentKindRegistry })`. A cross-runtime "registered custom kind resolves
  identically" assertion was added.
- The extension seam is a breaking change: the three runtime `src/index.ts` entry points no
  longer re-export `registerAgentKind`/`clearRegisteredAgentKinds`; a deployment now injects a
  pre-loaded registry through the container/`start()`/`startLocal()` instead.
- All three facades and the conformance harness had to land together (per "keep the runtimes
  symmetric") to avoid a facade-parity gap.

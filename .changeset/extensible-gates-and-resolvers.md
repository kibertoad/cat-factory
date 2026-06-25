---
"@cat-factory/kernel": minor
"@cat-factory/orchestration": minor
"@cat-factory/conformance": patch
"@cat-factory/example-custom-agent": patch
---

Make the polling **Gate** and **StepCompletionResolver** mechanisms externally
extensible, so a company-authored deployment package can register its OWN full-blown gate
(deterministic probe + helper/companion agent + exhaustion handling) or step resolver
purely via an import side effect — exactly the way it already registers a custom agent
kind. No fork, no engine patch, and no executor-harness image change (pure backend TS).

- **kernel**: new `domain/gate-registry.ts` (`registerGate(kind, factory)` +
  `GateDefinition`/`GateContext`/`GateProbe`/`recordGateAttempt`/…) and
  `domain/step-resolver-registry.ts` (`registerStepResolver(kind, factory)` +
  `StepCompletionResolver`/`ResolverContext`/…), moved out of orchestration so an
  extension package depends only on kernel + agents. `RaiseNotificationInput` moved to
  `ports/notification-channel.ts` so the runtime-neutral `GateContext` can build one. A
  registered gate/resolver is a `(ctx) => Definition` factory the engine invokes once at
  registry-build time — solving the `this`-capture the built-in gates rely on while
  keeping them inline and unchanged.
- **orchestration**: `ExecutionService.buildGateRegistry()` /
  `buildStepResolverRegistry()` now merge the deployment-registered factories with the
  built-ins (registered replaces built-in of the same kind, last-wins) via new
  `makeGateContext()`/`makeResolverContext()` seams; the gate/resolver types are
  re-exported from the package index for discovery.
- **example-custom-agent**: registers a `license-check` gate (escalating to a new
  `license-fixer` agent kind) + an auditor step resolver + a `wireLicenseProvider` seam,
  proving a custom gate ships with zero engine changes.
- **conformance**: a new cross-runtime assertion drives a registered custom gate
  (pass-through, escalate-then-pass) and a registered step resolver on both runtimes.

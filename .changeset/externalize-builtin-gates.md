---
"@cat-factory/gates": minor
"@cat-factory/kernel": minor
"@cat-factory/orchestration": minor
"@cat-factory/worker": patch
"@cat-factory/node-server": patch
"@cat-factory/conformance": patch
---

Dogfood the extensible-gates seam: the built-in polling-gate suite (`ci`, `conflicts`,
`post-release-health` + the `on-call` escalation) is no longer hard-coded in the engine —
it ships as a new **`@cat-factory/gates`** package authored ENTIRELY through the public
`registerGate` seam, depending only on kernel + contracts. If the platform's own gates can
be expressed as an external package, so can any deployment's.

**Breaking (pre-1.0, no migration):** the `ci` / `conflicts` / `post-release-health`
providers leave the engine. `ciStatusProvider`, `mergeabilityProvider`,
`releaseHealthProvider` and `incidentEnrichment` are removed from
`ExecutionServiceDependencies` / `CoreDependencies`; a deployment now wires them into the
gate suite via the exported `wireCiStatusProvider` / `wireMergeabilityProvider` /
`wireReleaseHealthProvider` / `wireIncidentEnrichment` handles after
`import '@cat-factory/gates'`. The merge collaborators (`pullRequestMerger`,
`branchUpdater`) stay on the engine.

- **gates (new)**: the three gate factories + the four provider wire-handles +
  `registerBuiltinGates()`, registered as an import side effect. Each gate is a
  pass-through until its provider is wired, so a bare import is always safe.
- **kernel**: the pure gate logic (`aggregateCi`/`classifyReleaseHealth`/… +
  `renderReleaseEvidence`) and the gate/helper agent-kind constants move into
  `domain/gate-logic.ts` so a gate package can author a gate without depending on the
  engine. New `GateDefinition.resolveHelperCompletion` hook (+ `GateHelperJobResult` /
  `GateHelperCompletionArgs`): the seam an INVESTIGATE-don't-fix helper (`on-call`) needs
  to settle a gate without re-probing — the real gap the dogfood surfaced.
- **orchestration**: the three inline gates + the bespoke `resolveOnCallStep` /
  `raiseReleaseRegression` / `enrichIncident` / `raiseCiFailed` branches are deleted; the
  engine builds its gate registry purely from what's registered, and drives an on-call-style
  helper completion through the generic `resolveHelperCompletion` hook. The **`merger`**
  step resolver stays a privileged built-in (reclassified): it owns terminal block status
  and executes a policy-gated real merge — a different archetype from the light, externally
  authorable resolvers, so it keeps its engine-internal access rather than the public seam.
- **worker / node-server**: each facade `import`s `@cat-factory/gates` and wires its
  existing provider impls (`GitHubCiStatusProvider`, `RegistryReleaseHealthProvider`, …)
  via the `wireX` handles instead of threading them through the engine. `local-server`
  inherits this through `buildNodeContainer`.
- **conformance**: a new cross-runtime assertion drives the externalized built-in `ci`
  gate (green pass-through, red → ci-fixer → re-probe) over a faked provider on both
  runtimes; the registered-gate test now restores the built-ins after clearing the shared
  registry.

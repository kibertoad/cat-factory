---
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/consensus': minor
'@cat-factory/sandbox': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/executor-harness': patch
---

Registry DI migration — the agent-kind registry becomes app-owned (no module global).

Continues the [registry-DI initiative](docs/initiatives/registry-di-migration.md): the
plugin-style agent-kind registry (`registerAgentKind` into a module-level `Map`) is replaced by
an app-owned **`AgentKindRegistry`** instance the composition root news once
(`defaultAgentKindRegistry()`, pre-loaded with the built-in `bug-investigator` / document /
initiative kinds), threads through the single `CoreDependencies` object, and re-exposes on the
`Core` + `ServerContainer` for the HTTP snapshot projection. Module identity stops mattering, the
external-adapter "phantom Map" gotcha is gone, and tests get a fresh instance instead of
`clearRegisteredAgentKinds()`. This also fixes the phase-F worker-shard conformance flake at its
root: the shared suite's `clearRegisteredAgentKinds()` used to wipe the built-in kinds for the
rest of a single-module run.

**BREAKING** — the free module-global seams are removed from `@cat-factory/agents` (and the
facade re-exports): `registerAgentKind`/`registerAgentKinds`, `registered*` (`registeredAgentKind`,
`registeredAgentStep`, `registeredKindRequiresContainer`, `registeredSystemPrompt`,
`registeredUserPrompt`, `registeredConfigContributions`, `registeredPreOps`, `registeredPostOps`,
`registeredAgentPresentation`, `registeredStructuredOutput`, `registeredWebResearchHint`,
`registeredAgentTuning`, `registeredAgentKinds`), and `clearRegisteredAgentKinds`. Instead export
the `AgentKindRegistry` class + `defaultAgentKindRegistry()` factory; the pure prompt/catalog fns
(`systemPromptFor`/`userPromptFor`/`traitsFor`/`hasTrait`/`agentTuningFor`/`configContributionsFor`/
`configContributionCatalog`/`webResearchGuidanceFor`/`isInlineModelStep`) now take a `registry`
argument, and a deployment registers custom kinds **by reference** on the instance it injects into
`buildContainer` / `start()` / `startLocal()` (the `agentKindRegistry` seam), exactly like the
backend-registries pilot. The runtimes stay symmetric and the cross-runtime conformance suite
injects a pre-loaded registry to assert a custom kind resolves identically on every facade.

Also fixes a warm-pool bug in the executor-harness: the read-only multi-repo explore fan-out
(`runExploreMode`) was gated on `!job.persistentCheckout`, so a `bug-investigator` dispatched to a
warm local pool (which injects `persistentCheckout: true` on every job) silently dropped its peer
repos and only saw the primary. The guard is dropped — `runMultiRepoExplore` uses its own
ephemeral workspace, so the flag is harmlessly ignored.

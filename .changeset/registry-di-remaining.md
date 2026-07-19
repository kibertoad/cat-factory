---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/gates': minor
'@cat-factory/gitlab': minor
'@cat-factory/consensus': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Migrate the last module-global plugin registries to app-owned DI (the registry-DI initiative):
pipelines, VCS providers, provider tokens, and agent traits now ride the composition root's
injected instances instead of a process-wide `Map`, removing the `clear*()` test cruft and the
phantom-`Map` hazard for separately-published adapter packages (e.g. `@cat-factory/gitlab`).

**Breaking (pre-1.0, no back-compat):** the following free functions are removed in favour of the
app-owned registry instances a facade injects:

- **Pipelines** (`@cat-factory/kernel`): `registerPipeline` / `registerPipelines` /
  `registeredPipelines` / `clearRegisteredPipelines` / `mergeRegisteredPipelines` →
  `PipelineRegistry` (`register` / `registerMany` / `registered` / `merge`) + `defaultPipelineRegistry()`.
  `seedPipelines(registry?)` now takes the registry (the no-arg form returns the built-in catalog).
- **VCS providers** (`@cat-factory/kernel`): `registerVcsProvider` / `getVcsProvider` /
  `resolveVcsProvider` / `requireVcsProvider` / `isVcsProviderRegistered` / `registeredVcsProviders` /
  `clearVcsProviders` → `VcsProviderRegistry` + `defaultVcsRegistry()` (a required `ServerContainer`
  field, so facade parity is type-enforced). `@cat-factory/gitlab`'s `registerGitLab` now takes the
  registry as its first argument.
- **Provider tokens** (`@cat-factory/kernel`): `wireProvider` / `getProvider` / `isProviderWired` /
  `requireProvider` / `clearProviders` → `ProviderRegistry` + `defaultProviderRegistry()`, read by the
  gate machine's `GateContext` (which gains `isProviderWired`). The `@cat-factory/gates` `wireX` /
  `applyGateProviders` / `warnUnwiredGates` handles take the registry as their first argument;
  `clearGateProviders` is no longer needed by a facade (a fresh registry per build starts empty).
- **Agent traits** (`@cat-factory/agents`): `registerAgentTrait` / `registerAgentTraits` /
  `registeredAgentTrait` / `clearRegisteredAgentTraits` / `assignAgentTraits` /
  `clearAssignedAgentTraits` are folded onto the app-owned `AgentKindRegistry`
  (`registerTrait` / `registerTraits` / `traitDefinition` / `assignTraits` / `assignedTraitsFor`);
  `traitsFor` / `hasTrait` / `traitGuidanceFor` keep their signatures. `@cat-factory/consensus`'s
  `registerConsensusTraits` now takes the registry as its first argument.

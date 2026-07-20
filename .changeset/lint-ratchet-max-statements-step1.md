---
'@cat-factory/app': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/executor-harness': patch
---

Lint ratchet: `max-statements` from its pinned baseline (157) down below 60 (no behavioural
change).

Every function above 50 statements is split along a cohesive seam so the `.oxlintrc.json`
`max-statements` ceiling can drop from 157 to 50. All extractions are behaviour-neutral (moved
code verbatim into well-named helpers, destructured at the top so the remaining bodies are
unchanged; verified by the package unit suites and the cross-runtime conformance suites on real
Postgres/workerd in CI):

- **`createUiModals`** (`app/stores/ui/modals.ts`, 157): the flat bag of modal refs + open/close
  handlers is grouped into cohesive sub-factories (`createHealthAdvisoryModals`,
  `createDocumentTaskModals`, `createIntegrationPanelModals`, `createSettingsModals`,
  `createInfraModals`, `createAiOnboardingModals`, `createMiscModals`) composed behind the shared
  hub came-from markers; the returned public surface is unchanged.
- **the LLM proxy handler** (`server/modules/llmProxy/LlmProxyController.ts`, 108): the workers-ai
  ceiling, the in-process dispatch, upstream resolution (local runner vs the DB-backed key pool),
  and the response relay are extracted into `applyWorkersAiCeiling` / `dispatchInProcess` /
  `resolveUpstreamTarget` / `relayUpstream` behind a per-call `ProxyCallContext`.
- **`registerCoreControllers`** (`server/app.ts`, 77): the controller mounts split into
  `registerRootControllers` / `registerWorkspaceControllers` / `registerWebhookControllers`
  (exact mount order preserved).
- **`resolveAuxiliaryRepos`** (`server/agents/ContainerAgentExecutor.ts`, 75),
  **`checkEntityCallScope`** (`server/persistence/rpc.ts`, 63), and the screenshot handler
  (`server/modules/artifacts/HarnessArtifactController.ts`, 51) are split along their existing
  seams.
- **`provisionRecipe`** (`integrations/modules/compose/ComposeEnvironmentProvider.ts`, 94):
  decomposed into `preflightRecipe` / `readRecipeComposeFiles` / `materializeRecipeEnvFiles` /
  `runComposeBuildAndUp` / `runRecipeStepsAndGate` / `resolvePreviewUrl`. `bringUp`
  (`SharedStackService.ts`, 60), `buildKubernetesRecommendation` /
  `detectFrontendConfig` (`environments/*-detect.logic.ts`, 58/52) split similarly.
- **`buildNodeContainer`** (`node/container.ts`, 63), the stale-run sweeper `tick`
  (`node/execution/pgBossRunner.ts`, 54), `bootServer` (`node/server.ts`, 53), and
  `buildLocalContainer` (`local/container.ts`, 51) extract cohesive sub-builders / sweeper
  closures.
- **the coder container callbacks** (`executor-harness/src/coding-agent.ts`, 67/63) extract
  `prepareCodingCheckout` / `finalizeCodingRun` / `prepareMultiRepoCheckouts` /
  `pushMultiRepoLegs`. The harness image tag is bumped accordingly.
- **orchestration**: `createCore` (`container.ts`, 71), the `RunDispatcher` step handlers
  (66/60), `SandboxRunService` (59), and `CompanionController` (56) split along cohesive seams.

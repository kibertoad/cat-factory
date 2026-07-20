---
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Lint ratchet: `complexity` step 1 (141 → 60; no behavioural change).

Every function above cyclomatic-complexity 60 is split along a cohesive seam so the
`.oxlintrc.json` `complexity` ceiling can drop from its pinned baseline (141) to the first
real step (60). All extractions are behaviour-neutral (verified by the server + orchestration
unit suites and the node/local config tests; the cross-runtime conformance suites cover the
`FakeAgentExecutor` + config paths on real Postgres/workerd in CI):

- **`loadNodeConfig`** (`node/config.ts`, 141): the giant `AppConfig`-assembly function is
  decomposed into cohesive per-section builders (`resolveProviderCaps`, `buildAgentRouting`,
  `buildGithubConfig`, `buildAuthConfig`, `buildEmailConfig`, `buildEnvironmentsConfig`,
  `buildRunnersConfig`, `buildRetentionConfig`, `buildLangfuseConfig`, `buildOtelConfig`,
  `buildExecutionConfig`).
- **`dispatchPersistenceCall`** (`server/persistence/rpc.ts`, 101): the scope-rule enforcement
  switch is lifted into `checkCallScope`, then split again into `checkEntityCallScope` (the
  block/service/user/owner resolver kinds) + a shared `checkOwnerPairScope`, keeping the two
  switches jointly exhaustive over `ScopeRule`.
- **`buildJobBody`** (`server/agents/ContainerAgentExecutor.ts`, 75): the multi-repo fan-out /
  conflict-resolver / merger-combined-diff / reference-repo+branch resolution is extracted into
  `resolveAuxiliaryRepos`.
- **`FakeAgentExecutor.run`** (conformance, 68): the decision/blueprints/spec-writer/companion
  cluster moves into `runProducerKinds`.
- **`buildNodeContainer`** (`node/container.ts`, 64): the app-owned registry resolution + EKS
  registration moves into `resolveNodeAppRegistries`.
- **`buildLocalContainer`** (`local/container.ts`, 66): the provider-agnostic PAT/VCS-client/
  repo-origin resolution moves into `resolveLocalVcs`.
- **`pollAgentJobInner`** (`orchestration/RunDispatcher.ts`, 61): the running-poll fold becomes
  `applyRunningFold` and the gate-helper re-probe becomes `reprobeGateAfterHelper`.

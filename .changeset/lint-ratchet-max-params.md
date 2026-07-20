---
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/executor-harness': patch
---

Lint ratchet: complete `max-params` (20 → 6, its final target; no behavioural change).

Refactored every function above the target from a long positional list to a bundled
argument, walking the `.oxlintrc.json` ceiling down 20 → 10 → 8 → 6:

- **DI builders → dependency objects:** the Node `buildNodeContainerExecutor`
  (`NodeContainerExecutorDeps`), the Worker `selectAgentExecutor` / `buildContainerExecutor`
  (a shared `WorkerExecutorDeps`), `buildResolveTransport`, and `selectEnvConfigRepairer`.
- **Loop-invariant step context → one object:** the deployer fan-out (`DeployerFanOut`
  threaded through `advanceDeployerFrames` / `settleDeployerFrame` / `settleDeployerFailure` /
  `completeDeployerStep`), the companion `applyAssessment` grading bundle, the Tester
  `failTester` failure bundle, and the gate `dispatchGateHelper` helper bundle.
- **`ExecutionService.start(...)` trailing options → `RunStartOptions`** (new
  `runStartOptions.ts`, keeping `ExecutionService.ts` under the `max-lines` ceiling), updated
  at every call site.
- **Callback / identity bundles:** `GitHubSyncService.syncResource` handlers,
  `RequirementReviewService.runWriterForChunk` (resolved model + grounding),
  `EnvironmentConnectionService.runProviderValidate` repo target, `SkillSourceService.syncSkillDir`
  dir descriptor, and the executor-harness `streamCli` CLI descriptor.

The executor-harness bump republishes the runner image (its `streamCli` refactor touches
`src/**`); the three image-tag pins + `RECOMMENDED_HARNESS_IMAGE` are synced to `1.50.1`.

---
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/node-server': patch
'@cat-factory/server': patch
---

Split the last six files above 1500 lines so oxlint's `max-lines` can reach its final target,
where it matches `check-file-size.mjs`'s default budget.

Every change is a behaviour-neutral move behind a thin delegate or a re-export, so no call site
changed:

- `ExecutionService` sheds the run-lifecycle surface (`start` / `retry` / `restartFromStep` /
  `resumePaused` / `cancel` / `stopRun` / `teardownForBlockTree`) to `RunLifecycleController` and
  the iteration-cap resolution to `IterationCapController`, built as one pair by
  `run-action-controllers.ts`.
- `RunDispatcher` sheds the dispatch side of a step to `AgentDispatchController` and its
  dependency declarations to `RunDispatcherDependencies.ts`.
- The provisioning detector's compose / stack-recipe half moves to `provision-detect.compose.ts`
  over a new shared `provision-detect.contract.ts`.
- The Node schema's outbound model-provider credential tables move to
  `db/tables/model-credentials.ts`, re-exported.

The extractions also stranded four private fields whose only readers moved out
(`RunDispatcher`'s `resolveRunRepoContext` / `resolveProviderCapabilities` / `modelIdIsMetered`
and `ExecutionService`'s `subscriptionActivations`). They were assigned and never read, which no
typecheck reports, so they are deleted rather than left as write-only state.

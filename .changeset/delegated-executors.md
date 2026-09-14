---
'@cat-factory/delegation-github-actions': minor
'@cat-factory/example-delegated-executor': minor
'@cat-factory/orchestration': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/node-server': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
---

Delegated executors: a pipeline step can now run in a system the deployment already operates (its own GitHub-Actions loop, job runner or PR bot) while cat-factory keeps the intake, the standards, the CI gate, the merge policy and the notifications around it.

A deployment registers a `DelegatedExecutorDefinition` on the new app-owned `DelegatedExecutorRegistry` and points an agent kind at it with `agent: { surface: 'delegated', executor }`. The executor is handed the same brief the container harness composes, so a workspace's prompt overrides and agreed standards reach both identically; its credentials resolve per call through the existing `ToolSecretResolver` port and never touch the brief.

Two things the platform states rather than guesses. A delegated step's model calls never reach this deployment's proxy, so the step card says "usage not reported by <executor>" and the run rollups carry `llm.reporting.delegatedStepsWithoutUsage` instead of rendering a zero. And a run stopped while external work is still running records whether it actually stopped: an executor that declares no `cancel` leaves its run alive, and the record says so.

Ships with `@cat-factory/delegation-github-actions` (a `DelegatedExecutor` over Actions: correlation by run name, since `workflow_dispatch` returns no run id) and a runnable example under `backend/internal/example-delegated-executor`.

Internals: `AgentSurface` gains `delegated`, `AsyncAgentExecutor.reclaimRun` may return a `RunReclaimReport`, and `PipelineStep` gains `delegated`. The run failure vocabulary gains `delegated_failed`, so an external system's terminal verdict is classified as its own thing rather than as a container that was shut down. Four new `error.details.reason` values, all additive: `delegated_executor_unwired` (409), `delegated_step_async_only` (409), `delegated_claim_missing` (409) and `delegated_executor_failed` (503).

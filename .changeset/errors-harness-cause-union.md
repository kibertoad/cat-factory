---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/integrations': patch
'@cat-factory/conformance': patch
---

Type the harness failure-cause wire and consolidate its classifiers (error-message initiative I4).
The kernel now owns the structured cause vocabulary — `HARNESS_FAILURE_CAUSES` /
`HarnessFailureCause` / `isHarnessFailureCause` / `failureKindFromHarnessCause`
(`kernel/src/domain/harness-failure.ts`), kept in step by hand with the dependency-free container
payloads (executor-harness `FailureCause` plus deploy-harness `DeployFailureCause`, hence the
`deploy` member) — and the three job-view ports carry the union instead of a bare string
(`RunnerJobView.failureCause`, the failed `AgentJobUpdate` variant, `PreviewView.failureCause`).
The mapper's internal `Record<HarnessFailureCause, 'timeout' | 'agent'>` is the drift guard: a new
union member without a mapping fails the typecheck.

The three per-flow copies of the cause switch are deleted in favour of that one kernel mapper:
orchestration's `agentFailureKindFromCause` (a module export of `job.logic.ts`, now removed —
`RunDispatcher` calls the kernel mapper), the bootstrapper's `bootstrapFailureKindFromCause`, and
the repairer's `repairFailureKindFromCause`. Each flow keeps its own error-string regex purely as
the no-cause fallback. `HttpRunnerPoolProvider` now narrows the pool's dot-path-mapped cause
through `isHarnessFailureCause` (an unknown free-form value degrades to the regex fallback instead
of riding the wire untyped), and the conformance `FakeAgentExecutor.pollFailCause` option is typed
to the union. Container eviction stays outside the union (a transport signal —
`RunnerJobView.evicted`). No executor-harness image bump: the harness sources are untouched.

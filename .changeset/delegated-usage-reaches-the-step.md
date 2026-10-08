---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
'@cat-factory/worker': minor
'@cat-factory/conformance': minor
---

A delegated executor's reported usage now reaches the step it belongs to. The step's metrics, the run totals and the "usage not reported by <executor>" gap all read `llm_call_metrics`, while a result's `usage` was written only to the usage ledger, so a `self-reported` executor's step still read as unreported. The delegated arm now files the figure as one job-level call metric through the same recorder a subscription harness uses (`standsForJob`, counted as the job's call), keyed on the dispatch's job id so a replayed poll records nothing twice.

That row is filed under kernel's new `DELEGATED_USAGE_PROVIDER` and is never priced: `LlmObservabilityService` answers no rate for it, so the step and the run totals show the tokens with an unknown cost instead of the deployment's fallback rate.

`DelegationUpdate`'s `failed` arm gains `usage`, with the meaning it has on a result. A run that fails late has usually spent most of its tokens, and it previously had no way to say so. `AgentJobUpdate`'s `failed` arm gains `usage` and `usageBilling` to carry it, and the failed-poll path meters it into the usage ledger and stamps the step's `usageBilling`, as the completion path does for a result.

Each settled delegation attempt records `usageReported`, and `delegatedSpendUnreported` reports a gap when the FINAL attempt reported nothing, even if an earlier attempt's row put calls in the step's metrics.

`RecordHarnessCalls` is exported from `@cat-factory/orchestration` as the one recorder type. `buildDelegatedAgentExecutor` takes a required `recordHarnessCalls` (its value may be `undefined`), so a facade cannot wire it on one runtime and forget it on the other. The Worker builds one recorder and hands it to both the container and the delegated arm; `buildWorkerJobAccountingDeps` now takes that recorder instead of building its own. Conformance's `withDelegatedArm` takes the facade's recorder, and a new conformance assertion checks on every runtime that a self-reported usage lands on the step unpriced.

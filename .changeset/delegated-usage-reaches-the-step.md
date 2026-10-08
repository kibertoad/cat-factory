---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/conformance': minor
---

A delegated executor's reported usage now reaches the step it belongs to. The step's metrics, the run totals and the "usage not reported by <executor>" gap all read `llm_call_metrics`, while a result's `usage` was written only to the usage ledger, so a `self-reported` executor's step still read as unreported. The delegated arm now files the figure as one job-level call metric through the same recorder a subscription harness uses (`standsForJob`, counted as the job's call), keyed on the dispatch's job id so a replayed poll records nothing twice.

`DelegationUpdate`'s `failed` arm gains `usage`, with the meaning it has on a result. A run that fails late has usually spent most of its tokens, and it previously had no way to say so.

`buildDelegatedAgentExecutor` takes a required `recordHarnessCalls` (its value may be `undefined`), so a facade cannot wire it on one runtime and forget it on the other. Both facades pass the recorder their container executor already uses.

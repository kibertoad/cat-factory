---
'@cat-factory/server': patch
---

Internal refactor: extract the runner-output → engine-result normalisation (`toRunResult`
and its per-kind coercions) out of `ContainerAgentExecutor.ts` into a dedicated
`containerAgentResult.ts` module, with co-located characterisation tests. Pure code move —
no behaviour, API, or wiring change.

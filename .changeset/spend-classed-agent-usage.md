---
'@cat-factory/kernel': patch
'@cat-factory/spend': patch
'@cat-factory/agents': patch
'@cat-factory/consensus': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
---

Meter agent token usage per INPUT CLASS instead of pricing every input token at the fresh
rate. `AgentTokenUsage` now carries an optional `inputClasses` split, filled in by the inline
AI-SDK path, the consensus strategies and the container harness, so the two `spend.record`
call sites that record from an agent result stop over-charging a cache-heavy run (measured at
4.7x on a `coder` dispatch that was 96% cache reads). `estimateCost` is now the single entry
point for pricing a usage and branches on the split internally.

Internal break: `RecordUsageInput.inputClasses` is gone — the split rides `usage.inputClasses`
instead, so a producer cannot report the two inconsistently. `ConsensusUsage` and spend's
`InputTokenClassUsage` are now aliases of the kernel types they duplicated.

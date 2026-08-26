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

Two rules the aggregate paths depend on: a multi-call usage fold applies the all-fresh
fallback per PART, so one consensus participant whose provider reports no cache details no
longer re-prices the whole panel at the fresh rate; and cache shares that overshoot their own
total clamp the CHEAPEST class, so a producer whose two channels disagree is charged the dear
class it reported rather than a tenth of it.

# `@cat-factory/consensus` — opt-in consensus orchestration

Fans an agent step across several runs and reconciles them (specialist panel / debate / ranked
voting), gated by a task estimate. Wired only when enabled; depends on agents + contracts +
kernel.

**Entry:** `src/index.ts`. `ConsensusAgentExecutor.ts` is the executor; `strategies/` holds the
reconciliation strategies (`rankedVoting`, `specialistPanel`, …); `gating.ts` the estimate gate;
`traits.ts` the shared types.

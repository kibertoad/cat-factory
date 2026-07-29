# `@cat-factory/consensus` — opt-in consensus orchestration

Fans an agent step across several runs and reconciles them (specialist panel / debate / ranked
voting), gated by a task estimate. Wired only when enabled; depends on agents + contracts +
kernel.

**Entry:** `src/index.ts`. `ConsensusAgentExecutor.ts` is the executor; `strategies/` holds the
reconciliation strategies (`rankedVoting`, `specialistPanel`, …); `gating.ts` the per-step estimate
gate; `traits.ts` the capability traits + `DEFAULT_CONSENSUS_ELIGIBLE_KINDS` (which carries the
REVIEW kinds — `reviewer`, `pr-reviewer`, `doc-reviewer`, `architect-companion`,
`spec-companion` — since a review is a judgement, the thing a panel is best at).

The reusable, TIERED half of the feature does NOT live here: a workspace's consensus-GROUP library
is core (`ConsensusGroupRepository`, `ConsensusGroupService`), and the engine selects a step's tier
at dispatch via kernel's `selectConsensusGroup` / `applyConsensusGroup`. The executor only ever
sees an already-decided `ConsensusStepConfig`, so this package never learns that a group store
exists. See the "Consensus panels" section of the root `CLAUDE.md`.

# `@cat-factory/consensus`: opt-in consensus orchestration

Fans an agent step across several runs and reconciles them (specialist panel / debate / ranked
voting), gated by a task estimate. Wired only when enabled; depends on agents + contracts +
kernel.

**Entry:** `src/index.ts`. `ConsensusAgentExecutor.ts` is the executor; `strategies/` holds the
reconciliation strategies (`rankedVoting`, `specialistPanel`, …); `gating.ts` the per-step estimate
gate; `traits.ts` the capability traits + `DEFAULT_CONSENSUS_ELIGIBLE_KINDS` (which carries the
REVIEW kinds `reviewer`, `pr-reviewer`, `doc-reviewer`, `architect-companion`, and
`spec-companion`, since a review is a judgement, the thing a panel is best at).

The reusable, TIERED half of the feature does NOT live here: a workspace's consensus-GROUP library
is core (`ConsensusGroupRepository`, `ConsensusGroupService`), and the engine selects a step's tier
at dispatch via kernel's `selectConsensusGroup` / `applyConsensusGroup`. The executor only ever
sees an already-decided `ConsensusStepConfig`, so this package never learns that a group store
exists. `gating.ts` likewise only NAMES the two outcomes of kernel's `clearsConsensusBar` rather
than reimplementing the axis comparison: the engine has to rank groups by the same rule before
any executor exists, and two copies would be two chances for the selected tier and the panel that
runs to disagree.

Participants run as plain INLINE model calls: no filesystem, no shell, no subagents. Most eligible
kinds are container kinds whose prompt and preOps assume the opposite, so the executor appends
`INLINE_PANEL_SURFACE` to every participant's system prompt (last, so a workspace override cannot
drop it) and the engine tells a kind's preOps via `RepoOpContext.deliversCheckout`. See the
"Consensus panels" section of the root `CLAUDE.md`.

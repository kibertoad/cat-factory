---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add the optional implementation-fork decision phase on the Coder step. Before the Coder
writes code, a read-only `fork-proposer` explore agent can aggressively surface the materially
different ways to implement a task; the run parks for a human to pick a proposed fork or enter
their own approach, and the chosen approach is folded into the Coder's prompt as a binding
directive. The phase is gated per-task by a tri-state (`auto`/`always`/`off`) and, in `auto`,
by an estimate gate on the workspace risk policy (`riskPolicy.forkDecision`, disabled by
default). All state rides the run's coder step (`step.forkDecision`), so it is
runtime-symmetric across the Cloudflare and Node facades (D1 ⇄ Drizzle: the new
`merge_threshold_presets.fork_decision` column). This slice ships propose → park → choose →
Coder plus the single-path auto-advance; grounded chat about the forks lands in a follow-up.

Breaking: the built-in merge-threshold preset catalog version is bumped (Balanced /
Manual review only → v3) to seed the new `forkDecision` gate; workspaces are advised to reseed.
The `build` Coder prompt is bumped to v4 and a new `fork-proposer` v1 prompt is added.

---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Initiatives slice 3 — the execution loop.

An approved initiative plan now RUNS: a new `InitiativeLoopService` drives each `executing`
initiative — reconciling its spawned tasks, spawning the next wave just-in-time, and completing
the initiative once every tracker item settles.

- **The loop** (`orchestration/modules/initiative/InitiativeLoopService.ts`): per-initiative
  `tick` = reconcile (fold each spawned task block's status back onto its item — done + PR link /
  `pr_open` / `blocked` + deviation, one batched block read, no N+1) → complete (all items settled
  → initiative + anchor block `done`, tracker re-commit, notify) → spawn (create task blocks for
  the eligible `pending` items — current phase, deps met, phase not halted — up to the concurrency
  cap, each pipeline chosen by the policy's estimate→pipeline rules). Spawning is CLAIM-FIRST (a
  rev-CAS write records the pre-generated block id before any side effect), so a concurrent ticker
  never orphans a double-spawn. A per-service task-limit conflict leaves the item `pending` for the
  next sweep; a missing pipeline (deleted after ingest) records a deviation + notification and
  blocks the item — the sweep never throws.
- **Blocked = halt the phase, notify.** A blocked item stops new spawns in its phase (and keeps the
  phase current, so the initiative never advances past it) and raises the new `initiative`
  notification type; in-flight siblings finish. A human retries/skips the item to unblock.
- **Both cron seams + terminal pokes.** `runDue` is wired into the Worker `scheduled` handler and a
  Node one-minute interval sweeper (symmetric). A settling child run pokes its owning initiative's
  loop immediately (`RunStateMachine.emitInstance` on a terminal run, `ExecutionService.finalizeMerge`
  on a merge), so work advances without waiting for the next sweep.
- **Controls.** Pause / resume / cancel endpoints + `InitiativeService` CAS transitions; the sweep
  skips a non-`executing` initiative. The tracker window gains a live progress bar and the inspector
  the loop controls (`initiative.inspector.pause/resume/cancel`, all locales).
- **`listExecuting()` now returns `{ workspaceId, initiative }[]`** (the entity carries no workspace
  id) — mirrored in the D1 + Drizzle repos and asserted, with the persisted loop-state round-trip,
  by the cross-runtime conformance suite.

No new persistence (the `initiatives` table already exists on both facades) — so no D1/Drizzle
migration and no executor-harness image bump.

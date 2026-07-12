---
'@cat-factory/app': patch
---

feat(ux): elapsed clocks, run-blocked reasons, guarded stops & keyboard-reachable restart (UX-35/40/41/42)

Closes the Section C "pipeline & inspector surfaces" cluster of the UX-papercuts initiative:

- **UX-35 — live elapsed clocks.** `PipelineProgress` and `TaskExecution` now show each
  step's elapsed time, driven by a shared 1s tick, so a running step that hasn't yet emitted
  subtask counts reads as progressing rather than hung. The clock freezes at the step's
  finish, the run's failure time, or a human park — reusing the same freeze rules as the
  step-detail overlay (the duration/`isRunning` logic in `useStepTimer` is extracted into pure
  helpers `stepDurationMs`/`stepDurationLabel`/`stepIsRunning` + a shared `useNowTick`).
- **UX-40 — the locked Run trigger says why.** The inspector's disabled Run button read as a
  dead lock; it now names the unfinished dependencies blocking the task, both as a button
  title and as a visible hint line (a native title on a disabled button never fires hover, so
  the hint keeps the reason reachable for pointer, keyboard, and touch alike).
- **UX-41 — stopping a run is confirmed.** The shared `AgentStopButton` (board card +
  inspector bootstrap stop) now routes through the confirm dialog before killing the
  container, matching the confirm-then-mutate contract the task-reset path already uses.
- **UX-42 — restart-from-here is keyboard-reachable.** The hover-only restart button on a
  pipeline step now also reveals on `group-focus-within`/`focus-visible`, so it is no longer
  invisible to keyboard and touch users.

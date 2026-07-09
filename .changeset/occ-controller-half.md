---
'@cat-factory/orchestration': patch
---

Finish the optimistic-concurrency (rev/CAS) migration — the CONTROLLER half (race-audit 2.2/2.3).

The driver half already routed the durable driver's writes through `RunStateMachine.casPersist`
(abort-and-re-drive on a lost race) and the single-action human handlers through `mutateInstance`.
The six gate-window controllers, however, still force-wrote the entire serialized instance via the
blind `persistInstance` — so a concurrent human action (or a `stopRun`/`cancel`) landing in a
controller's read→write window could silently clobber the winner or resurrect a deleted run. This
closes that half:

- **Driver-path controller writes → `casPersist`.** The gate `evaluate` / `completeStep` / dispatch
  / apply-assessment paths in `CompanionController`, `TesterController`, `HumanTestController`,
  `InterviewGateController`, `VisualConfirmationController`, and `ReviewGateController` run inside the
  driver's `advanceInstance` / `redriveOnContention` envelope, so a lost race throws
  `RunContendedError` and re-drives on fresh state — exactly like `handleAgentStep`.
- **HTTP human-action handlers → `mutateInstance`.** Review `incorporate` / `offloadRecommendation` /
  `resumeRun`, human-test & visual-confirm `signalAction` + `destroyEnvironment`, interview `resume`,
  and `ExecutionService.resolveCompanionExceeded` now load fresh, re-find the parked gate, apply the
  pure mutation under `compareAndSwap`, and run their non-idempotent side effects (driver signal /
  emit / dispatch / env teardown) once after, on the winning snapshot.
- **Gate-resume split.** The blind combined `RunStateMachine.advancePastResolvedGate` is deleted;
  every gate-resume path now uses the pure `advanceRunPastGate` (inside `mutateInstance`) +
  the side-effect `settleAdvancedGate`.

Cross-runtime conformance adds a repository-layer assertion for the `mutateInstance` reload-and-retry
contract — a racing human write reloads and lands alongside the driver's write instead of clobbering
it — proven identically on D1 and Postgres.

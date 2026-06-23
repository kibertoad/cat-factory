---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Unify the pipeline's polling-gate steps (`ci`, `conflicts`) behind one declarative Gate
framework, and apply the same "skip the work when it isn't needed" idea to the inline
requirements-incorporation companion.

The gates already only spun up their helper container agent (`ci-fixer` /
`conflict-resolver`) on a real red check / actual conflict — a green CI or mergeable PR
always advanced with nothing spun up. But the two gates were near-identical ~70-line
methods (`evaluateCi`/`evaluateConflicts`), duplicated `pollCi`/`pollConflicts`, two
`pollAgentJob` completion branches, two `AdvanceResult` variants, two step-state shapes,
and two copy-pasted sleep/poll loops in **both** durable drivers. Adding a third gate
meant copying all of it.

Now a gate is a `GateDefinition` registry entry (`modules/execution/gates.ts`) supplying
only its differentiators — `wired()`, `probe()` (→ `pass` / `pending` / `fail`),
`helperKind`, `onExhausted` — and one generic machine drives every gate:
`ExecutionService.evaluateGate` / `dispatchGateHelper` / `pollGate`. Both durable drivers
(Cloudflare `ExecutionWorkflow`, Node `drive.ts`) collapse their two poll loops into one
`awaiting_gate` branch. Behaviour is unchanged; the duplication is gone, and a new gate
is now a registry entry rather than a new copy of the machinery.

**Companion skip.** `hasNotesToIncorporate` short-circuits `runIncorporationCycle` so the
requirements rework + re-review LLM calls are skipped when the human left nothing to fold
in (every finding dismissed, no answered replies, no redo feedback): the review settles
`incorporated` with no LLM call and downstream agents fall back to the original
description.

BREAKING (wire + API): the per-step gate state moves from `step.ci` (`CiStepState`) /
`step.conflicts` (`ConflictsStepState`) to a single `step.gate` (`GateStepState`, phases
`checking`/`working`); the `awaiting_ci`/`awaiting_conflicts` `AdvanceResult` variants
become `awaiting_gate`; and `ExecutionService.pollCi`/`pollConflicts` become `pollGate`.
Steps persist as opaque JSON, so there is no DB migration — in-flight gate runs simply
re-derive their state. The frontend does not read this state, so the SPA is unaffected.

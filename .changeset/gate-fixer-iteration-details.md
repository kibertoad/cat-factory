---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/gates': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': minor
---

Surface per-iteration fixing instructions in polling-gate run details. A `ci` /
`conflicts` gate's helper attempt now records the instructions it was handed (the
failing-check summary + structured red checks for CI, the conflict/review detail for the
others) alongside the helper's own report, so the gate window shows WHAT each round set out
to fix — bringing the gate attempt timeline to parity with the Tester's fixer timeline
(`concerns` + `summary`). Adds `instructions` / `failingChecks` to `gateAttemptSchema` and a
transient `lastDispatchedInstructions` stash on `gateStepStateSchema` (schemaless step JSON,
no migration).

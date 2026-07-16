---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': minor
'@cat-factory/conformance': minor
'@cat-factory/local-server': patch
---

Add a "Ralph loop" task type: a persistent retry-until-done coding loop whose exit condition is
a programmatic validation command the harness runs against the checkout (exit 0 = done), bounded
by a per-task iteration budget and surviving restarts.

Each iteration is a fresh-context container-coding run that works the task spec; the harness then
runs the task's configured `ralph.validationCommand` (bounded timeout, redacted output tail) and
reports the verdict on the run result — never a model self-report. The engine (`RalphController` +
a `ralph-verdict` step-completion interceptor, modelled on the Tester→Fixer loop) re-dispatches a
fresh iteration on a failing verdict until it passes or the `ralph.maxIterations` budget (default 10) is spent, then hands off to a human. Loop state rides the persisted `step.ralph` (no
migration), so a mid-loop run is re-driven from where it was by both durable drivers + sweepers.

- New `ralph` agent kind (the reusable loop-body primitive) + the `pl_ralph` pipeline
  (`ralph → conflicts → ci → merger`) + a `ralph` task type (a one-click creation entry point).
- The validation command + iteration budget are per-task agent config; `AgentConfigDescriptor`
  gained `text`/`number` control types for them.
- Cross-runtime conformance coverage (loop completes / exhausts / refuses to start unconfigured)
  and pure-logic unit tests.

Breaking: none (pre-1.0; `taskType` / `step.ralph` / the descriptor types are additive). The
executor-harness image is bumped for the new in-container validation capability.

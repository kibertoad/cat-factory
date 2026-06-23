---
'@cat-factory/contracts': minor
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Quality companions (Spec Reviewer, coder's Reviewer, Architect Companion) no longer
get stuck when they spend their automatic rework budget — they park for a human, the
same way the requirements reviewer does at its iteration cap.

Previously a companion that stayed below its quality bar after `maxAttempts` automatic
reworks failed the run (`companion_rejected`), leaving the task stuck with no path
forward. Now it parks on a shared iteration-cap gate offering the same three choices as
the requirements reviewer:

- extra-round — raise the budget by one and loop the producer back for one more pass;
- proceed — advance the pipeline accepting the producer's current output;
- stop-reset — cancel the run and return the task to phase zero (editable), the
  producer's latest output preserved on its branch.

The two gates now share one mechanism rather than duplicating it: the choice contract
(`iterationCapChoiceSchema` / `resolveIterationCapSchema`), the parking
(`parkStepOnDecision`), the gate-resume advance (`advancePastResolvedGate`, also used by
the generic approval gate), the three-way dispatch (`dispatchIterationCap`, where
stop-reset is uniformly `cancel()`), and the guard that stops the generic
approve/request-changes/reject resolvers from short-circuiting an iterative gate
(`assertNotIterativeGate`). The frontend renders both with one `IterationCapPrompt`
component.

`companion_rejected` now means only a genuinely unparseable companion verdict (truncated
/ malformed even after a repair retry) — exhausting the rework budget is no longer a
failure. New `companion.exceeded` flag marks a parked companion gate;
`POST /executions/:executionId/steps/:approvalId/resolve-exceeded` resolves it. No new
persistence — the gate reuses the existing execution row + durable decision-wait, so both
runtime facades get it; the cross-runtime conformance suite asserts the parking and all
three resolutions against both.

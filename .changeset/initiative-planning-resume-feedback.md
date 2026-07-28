---
'@cat-factory/app': patch
---

Make both interview windows show that continue/proceed did something. The resume is asynchronous
by design (the call records the intent on the parked step and wakes the durable driver, which runs
the interviewer LLM), so the response carries the pre-resume entity and an entity-keyed window
rendered identically before and after the click — indistinguishable from a dead button for as long
as the pass took. The initiative-planning and document-interview windows now fold their run's
status in through a shared `interviewGatePhase`, rendering a waiting state while a pass is in
flight and a failure notice when the run stopped before the interview settled; planning also gets
a distinct "not started yet" state instead of borrowing the converged copy. The initiative board
card and inspector follow the same phase, so they stop offering "Answer planning questions" (and
pulsing) over a question set that is already submitted.

Renames the action-rail controls in both windows, which both read as "go forward": "Continue" is
now "Submit answers", and "Proceed to plan" / "Proceed to draft" are "Plan now" / "Draft now",
with tooltips and reworded hints. A disabled "Submit answers" now states how many questions are
still unanswered rather than greying out silently — except where the workspace RBAC gate is what
blocks it, which keeps precedence.

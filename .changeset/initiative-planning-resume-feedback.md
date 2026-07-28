---
'@cat-factory/app': patch
---

Make the initiative planning window show that continue/proceed did something. The resume is
asynchronous by design (the call records the intent on the parked step and wakes the durable
driver, which runs the interviewer LLM), so the response carries the pre-resume entity and an
entity-keyed window rendered identically before and after the click — indistinguishable from a
dead button for as long as the pass took. The window now folds the planning run's status in and
renders a waiting state while a pass is in flight, a failure notice when the run stopped before
the interview settled, and a distinct "not started yet" state instead of borrowing the converged
copy. The board card and inspector follow the same phase, so they stop offering "Answer planning
questions" (and pulsing) over a question set that is already submitted.

Renames the two action-rail controls, which both read as "go forward": "Continue" is now "Submit
answers" and "Proceed to plan" is now "Plan now", with tooltips and a reworded hint. A disabled
"Submit answers" now states how many questions are still unanswered rather than greying out
silently.

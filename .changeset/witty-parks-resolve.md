---
'@cat-factory/app': patch
'@cat-factory/orchestration': patch
---

Fix the dead-end "Approve & proceed" rail on a Coder step parked for a dedicated decision.

A coder parked on the follow-up gate (or the implementation-fork choice) rides `step.approval`,
so every generic approval surface — the inspector "Approve" button, the focus-view
"Review & approve" chip, and the step-detail rail — offered a generic approve the server
deliberately refuses (409), and the failure was swallowed client-side: the button blinked and
nothing happened. The step click now routes those parks to the window that can resolve them
(follow-up triage / fork choice), the step-detail overlay swaps the rail for a redirect when a
step parks while it is open, and approve/request-changes/reject failures surface as actionable
toasts (closing the overlay only on success). Server-side, the fork-decision park is now guarded
in `assertNotIterativeGate` like the other dedicated gates — a stray generic approve could
previously advance the run past the coder without the build ever dispatching.

---
'@cat-factory/app': minor
---

Tutorial tours now cover the whole delivery loop, not just the board layout. Four new tours
join the two shipped ones and each is gated on the state the previous one leaves behind, so
the launch prompt offers only what the board can actually demonstrate: link a repository
(the gap that mattered most — a brand-new workspace was offered an orientation tour of an
empty canvas and no route to a first service), open a task and start its run, answer a run
that has parked for a human, and read a finished run's result through to the merge. Board
basics also names the basic/advanced switcher, which otherwise hides half the product from
whoever never finds it. `run-task` deliberately does not click Start for you: a run spends
model budget, so the tour points the control out and leaves the decision.

Two capabilities behind them. A STEP may now carry its own `when(gates)` and is dropped
rather than skipped when it doesn't apply — a run parked on a decision has no approval gate,
and reporting that as an abridged walkthrough misdescribes a tour that showed exactly the
right thing; a tour left with no steps is dropped too, so it can never open on an empty
cursor. And a step may carry `bodyParams`, which is how the sample repository slug the tours
point at lives in code instead of being translated into ten catalogs.

Gates gained `boardHasTask`, `boardHasRun`, `boardHasOpenDecision`, `boardHasPendingApproval`
and `boardHasFinishedRun`; a consumer deployment's own tours can gate on them too. The
add-service modal gained `data-testid` anchors for its repository field and add button.

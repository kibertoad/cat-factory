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
and `boardHasFinishedRun`; a consumer deployment's own tours can gate on them too. All five
are scoped to what a TASK CARD renders rather than to what the execution store holds — a park
on a frame block has no card to point at, and a reviewer gate mid-cycle is suppressed by the
card as background work — so a tour is never offered onto a control that isn't there. The
add-service modal gained `data-testid` anchors for its repository field and add button.

Three fixes to the tour runtime that these run-state gates surfaced:

- **A running tour's script is now resolved once and held, not re-read from the gated slot on
  every flip.** A gate over live run state flips as a direct result of following the tour, so
  the walkthrough that teaches you to answer a parked run used to vanish the instant you
  answered it — the overlay tore itself down one step short of its own finish card, with
  nothing recorded as completed. Gates decide what is OFFERED; they no longer rewrite a
  walkthrough already under way.
- **A click-to-advance step now matches its control by selector, not by the one element the
  ring happens to sit on.** `task-card`, `task-resolve` and `run-step` render once per board
  item, so a user who clicked the card the step's own copy asked for got no advance at all —
  and such a step renders no Next button, leaving Skip as the only way out.
- **The abridged notice ignores a skipped step that carries a `when`.** With no gates service
  wired every branch of a tour is kept and only one can anchor, which put a permanent "you
  missed some of this" on a tour that showed exactly the right branch.

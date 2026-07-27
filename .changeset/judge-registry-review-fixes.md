---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': patch
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Judges: fix the parking card never clearing, validate judges at boot, and make an unreadable verdict legible.

Follow-up on the review of the `JudgeRegistry` seam.

**A resolved judge park left its card open.** `judge_review` was added to the notification
union and to the review-debt list, but the DISMISSAL list was a third hard-coded literal
inside `NotificationService.clearWaitingDecision` — so the card survived every resolution
path and the escalation sweep would later flip an already-answered decision red as
"Overdue". The list is now the shared `GATE_CLEARED_NOTIFICATION_TYPES` contract, exported
from `@cat-factory/contracts` beside `REVIEW_WAIT_NOTIFICATION_TYPES`, so a new parking
surface cannot be added to one and forgotten in the other.

**Judges are validated at boot.** `validateRegistrations` accepts the `judgeRegistry`
(threaded from all three facades): a judge kind now counts as a legal pipeline step —
without it a pipeline placing a registered judge reports `pipeline_unknown_kind` — a
judge's `presentation.resultView` is checked like an agent kind's, and a judge kind that
collides with a registered gate kind is an error, because the polling-gate handler claims
the step first and would make the judge dead code.

**An unreadable verdict says why.** A model answering on a 0..100 scale was clamped to
`0.00` beside a sensible summary, reading as a damning verdict rather than a scale error.
The cautious zero stays; the new `annotateOutOfRangeScore` attaches a finding explaining it.
A zero bounce budget no longer reports "Rework budget spent (0/0)" for a round that was
never offered.

**Also:**

- The assessment prompt gained a TOTAL size budget (24k chars, newest-first) on top of the
  per-entry cap, and states in-prompt what it omitted — a long pipeline previously sent
  ~90 KB per judge round and paid it again on every bounce.
- `activeJudgeStepIndex` (contracts) replaces four local scans with three different
  precedences, which in a multi-judge pipeline could have the API answer about one rubric
  while the SPA echoed the result onto another.
- New `CoreDependencies.judgeModel` / `judgeResolveModel` make a judge's deployment-default
  model a documented dependency rather than a silent reuse of the inline reviewers'; the
  fallback to the reviewers' keeps "no per-facade wiring" true.
- The judge step is persisted, not just emitted, before the assessment — a durable-driver
  replay re-ran the model call and could broadcast a second, differing verdict.

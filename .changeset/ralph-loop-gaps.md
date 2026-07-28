---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Close five gaps in the Ralph loop, of which two silently changed what a run actually did.

A re-run un-looped the step. `retry.logic.resetStep` rebuilds a step from an explicit field list
and so DROPPED `step.ralph`. Unlike `step.test` — seeded lazily when the tester's report arrives
— the loop state is needed BEFORE the dispatch: it is what puts the `validation` block on the job
body. So a retried or restarted ralph run dispatched a plain coding pass, got no verdict back,
never fired the `ralph-verdict` interceptor, and finished as an ungated one-shot coder. The
loop-back reset (`StepGraph.resetStepForRerun`) had the mirror-image bug: it preserved the state
with `attempts` still at the spent budget, so the re-run's first verdict went straight to
`exhausted`. Both now go through the pure `restartRalphState` — frozen config kept, counters
zeroed.

The validation command starved the inactivity watchdog. `JOB_INACTIVITY_MS` (10 min) is tighter
than the command's own watchdog (15 min), and a harness-spawned command emits no activity of its
own, so any validation past ten minutes aborted the iteration as a wedge and made the 15-minute
watchdog unreachable at stock settings. It now heartbeats at 30s like the two sibling harness-run
phases.

`runRalphValidation` was a third copy of what `captured-command.ts` exists to prevent, and had
drifted in both ways that seam guards: it scrubbed secrets AFTER the rolling truncation with no
margin (a credential straddling the cut lost its `KEY=` prefix and survived redaction as an
unrecognised partial — on a tail that reaches the step, the notification and the SPA), and it
published the full 16k in-container capture where both siblings bound the wire tail. It now runs
through `runCapturedCommand` at a 4k report budget.

The loop also gains the no-progress early abort the design had deferred: the harness stamps the
work branch's HEAD onto the verdict, and two consecutive failing iterations against an unchanged
head end the loop instead of burning the rest of the budget. It fails open on an unknown head (an
older harness image never trips it) and is reported distinctly from a spent budget, since only one
of the two is fixed by raising the budget. Finally, the per-iteration attempt log — which rides
the run `detail` blob re-serialized on every progress write — is capped, with the dropped count
recorded and surfaced rather than silently truncated.

Image-affecting: bumps the runner image to 1.67.0.

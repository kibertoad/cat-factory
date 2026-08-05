---
'@cat-factory/contracts': minor
'@cat-factory/app': minor
---

Non-code outcome summary: "read the result" lands on evidence, not a diff

Reading a finished run meant reading a pull request. Everything a person who does not read diffs
needs was already captured (the tester's structured report, the screenshots it took, the
visual-confirmation pairs a human reviewed, the per-requirement verdicts it returned) and every
piece of it sat behind its own STEP-keyed window, so it was reachable only by someone who had
already learned the pipeline. The engine composes exactly these facts for the reviewer on the pull
request; the person who asked for the work got a branch name.

There is now an OUTCOME result view, keyed by the RUN: what was asked in the requester's own words,
which of the service's requirements the tester ruled on and what it observed against each, the
tester's verdict and concerns, the views it captured (against their reference designs when a human
reviewed them), and the checks that recorded a verdict, with every pull request the run opened at
the top of the card. It is what the board's `pr_ready` and `done` cards and the inspector's
execution panel open, and the `outcome` run deep link resolves to it.

The composition is a pure reduction (`utils/runOutcome.ts`) over state the SPA is already streamed,
not a new endpoint and not a model asked to summarise itself. That was the main decision: an
endpoint would have meant a second producer of the facts the PR verification report already
composes, and the two would disagree about what a run proved. The cost is that requirement TITLES
come from a best-effort read of the service spec, which the card says when it did not happen rather
than letting a requirement id read as its name. The same discipline covers every section: an absent
producer states WHICH one was missing, a tester that could not run at all is kept apart from one
that ran and raised concerns, and a regression (an `established` requirement observed to fail) is
computed from the spec's state and the tester's verdict rather than read off any report.

Worth watching in review: the board card's basic-mode behaviour. A `pr_ready` card drops its raw
pull-request chip in basic mode, because the outcome card it now leads with carries that link at the
top. That is an ordering change, not a hidden capability, and advanced mode keeps both.

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
execution panel open, on a task that has something to show; a task with no pull request and no
recorded evidence offers no card rather than an empty one. The `outcome` run deep link
(`?run=…&block=…&view=outcome`) resolves to it as well: nothing emits that link yet (the engine's
verification report links a REVIEWER to the run-scoped panels it already served), so today it is
the entry point for a URL a person shares.

The composition is a pure reduction (`utils/runOutcome.ts`) over state the SPA is already streamed,
not a new endpoint and not a model asked to summarise itself. That was the main decision: an
endpoint would have meant a second producer of the facts the PR verification report already
composes, and the two would disagree about what a run proved. The cost is that requirement TITLES
come from a best-effort read of the service spec, and the card says so rather than letting a
requirement id read as its name: a spec it never read and a spec it DID read that names none of
the reported ids are different sentences, and where only some ids resolved, the rows that did not
are marked individually instead of sitting unmarked beside their named neighbours.

The same discipline covers every section: an absent producer states WHICH one was missing, a tester
that could not run at all is kept apart from one that ran and raised concerns, a run the SPA cannot
resolve is stated as that rather than as a pipeline that recorded nothing, and a regression (an
`established` requirement observed to fail) is computed from the spec's state and the tester's
verdict rather than read off any report.

Worth watching in review: the board card's basic-mode behaviour. A `pr_ready` card drops its raw
pull-request chip in basic mode, because the outcome card it now leads with carries that link at the
top. That is an ordering change, not a hidden capability, and advanced mode keeps both. The chip's
condition states that as the invariant it is (drop it only where the outcome card is offered), so
the tier can reorder two routes to the diff but never remove the last one.

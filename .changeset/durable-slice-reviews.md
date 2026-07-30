---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Make a PR review's finished slices durable while it runs, instead of losing them all if it never
reaches its aggregation pass.

The reviewer fans a large diff out across parallel subagents, then folds their findings into one
structured output at the very end. Until that output arrives the step holds nothing but progress
counts: `prReview.slices` and `prReview.findings` are both `[]`, because `coercePrReview` runs
exactly once, from the terminal result. So the entire review lived in the container's memory until
its last second, and anything that killed it first — the inactivity or max-duration watchdog, an
evicted container, a wedged aggregation — threw away every completed slice and left a re-run from
zero as the only option.

The measured incident makes the cost concrete: 18m05s wall clock and 25.46M input tokens, of which
the final **196 seconds** were a single silent turn generating the findings JSON. During that window
all nine task-list entries read complete, `findings` was still empty, and `lastActivityAt` had
frozen — because the heartbeat is fed by tool-call events and subagent transcript growth, and a long
single completion produces neither. A run in that state is indistinguishable from a wedged one, and
its 60-minute ceiling was the only thing that would ever have ended it.

The fix reads what was already on the wire and being discarded. A subagent's dispatch and its
terminal `tool_result` both appear on the parent stream (only its intermediate turns don't), and the
slice tracker was matching that `tool_result` purely to flip a `done` flag while dropping the report
inside it. It now captures that report — bounded, credential-scrubbed — and publishes the whole set
on the job view as each slice lands. The engine folds it onto `prReview.sliceReviews`, so completed
review work is persisted continuously rather than at the finish line.

Notes for reviewers:

- The channel is a **whole-value latest publish**, not the drain-on-read that `followUps` and
  `spans` use. Those can afford to lose a poll window; this one carries the work being protected, so
  a dropped poll response must cost nothing. The fold is correspondingly monotonic: it never demotes
  a `completed` slice back to `in_progress` and never drops a report the incoming set omits, because
  a restarted container's tracker only knows the slices it dispatched and forwarding that verbatim
  would erase the previous attempt's reports.
- `sliceReviews` is **cleared** once the aggregated findings are recorded. The reports exist to make
  a review recoverable before its terminal output, and their content is folded into the findings by
  then; keeping eight ~24KB prose reports would leave a quarter-megabyte of redundant text on every
  run row.
- Wire-shape change (no compatibility shim, per the pre-1.0 policy): `prReviewStepStateSchema` gains
  a required-with-default `sliceReviews`, so every construction site supplies it. Existing rows
  simply read as an empty list.
- Local and Cloudflare container transports forward the job view verbatim and needed no change. A
  **runner-pool** deployment does not yet map this field, so a pool-backed review keeps the old
  all-or-nothing behaviour until a `sliceReviewsPath` is added to the manifest.

This is the persistence half only. It stops the data loss, and it is what a manual resume of a
wedged review needs in order to redo just the unfinished slices, but the resume action itself is not
here: re-dispatching with the captured reports as context requires a seam that reaches the STEP,
which `RepoOpContext` (block-scoped) does not, so it belongs with `AgentContextBuilder` in its own
change rather than bolted on here.

Still unaddressed, and deliberately: a long single completion produces no stream events at all, so
`lastActivityAt` freezes and a run in its aggregation tail still reads as wedged. A synthetic beat
would defeat the inactivity watchdog outright, and real token deltas need
`--include-partial-messages` plus a rework of the call aggregator's `message.id` folding. Until then
the captured reports are the tell: every slice `completed` with `findings` still empty means
aggregating, not stuck.

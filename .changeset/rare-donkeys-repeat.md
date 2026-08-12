---
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
---

Make every re-dispatch mint a fresh harness job id, and make the producer answer the review.

A container-backed producer looped back by its companion kept the same harness job id, so the
harness replayed its first completed job: same output, same recorded usage, no model call. The
companion then re-graded a byte-identical artifact and, correctly, never moved its rating. On a real
run the architect was dispatched four times, produced one container session and four identical
`token_usage` rows, and the score sat at 0.76 until the rework budget ran out.

`dispatchEpochFor` no longer sums per-loop counters (which had to be extended for each new loop, and
could go DOWN when a loop-back zeroed one). It reads the run's own dispatch record, so the job id
names the n-th job of that kind in the run: unique by construction, across re-dispatches AND across
two steps escalating the same helper kind. That closes the same replay on the tester's
quality-control re-run and on both human-gate fix loops, which were exposed too. The deploy path's
analogue now counts the human-test gate's rebuild loop-back for the same reason.

Producers are also required to account for every point raised (change it and say what changed, or
leave it and say why) in their REPLY rather than in the artifact they commit, and the grader is told
to check that accounting against the work rather than believe it. A rework round now says whether a
person or an automatic reviewer asked for it, since both arrive through the same prompt slice.

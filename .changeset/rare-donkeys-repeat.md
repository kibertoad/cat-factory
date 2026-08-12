---
'@cat-factory/orchestration': patch
'@cat-factory/agents': patch
---

Make a companion rework round actually re-run its producer, and make the producer answer the review.

A container-backed producer looped back by its companion kept the same harness job id, so the
harness replayed its first completed job: same output, same recorded usage, no model call. The
companion then re-graded a byte-identical artifact and, correctly, never moved its rating. On a real
run the architect was dispatched four times, produced one container session and four identical
`token_usage` rows, and the score sat at 0.76 until the rework budget ran out. `dispatchEpochFor`
now counts the step's own re-starts, so any re-dispatch mints a fresh job id whether or not the loop
that drove it has a counter of its own.

Producers are also now required to account for every point raised (change it and say what changed,
or leave it and say why), and the grader is told to check that accounting against the work rather
than believe it.

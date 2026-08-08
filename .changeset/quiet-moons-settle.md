---
'@cat-factory/orchestration': minor
---

Put the run's terminal transition in one place on `RunStateMachine`.

The "finish this step, then finish the run or advance the cursor" epilogue was copy-pasted at
seven sites, each re-asserting by hand that `stopRunContainer` may fire only on the final step
and that the persist must precede the emit. `settleStepAndAdvance` owns both invariants, with the
three real variations (`confidence`, `resolverOwnsTerminalStatus`, the interview gate's extra
state) as options. `persistAndEmit` replaces the 29 remaining adjacent `casPersist` + `emitInstance`
pairs, and `recordDispatchedJob` bundles the job id, the dispatch attribution and the container
projection at the six dispatch sites, so omitting the attribution (a silent regression that lands
as "unknown" in production, never as an error) now takes deleting a call rather than forgetting a line.

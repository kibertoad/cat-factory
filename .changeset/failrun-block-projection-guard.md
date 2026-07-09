---
'@cat-factory/orchestration': patch
---

fix(execution): don't clobber a merged task's block to `blocked` when a stop races the merge (race-audit 2.3 follow-up)

Race-audit 2.3 closed the terminal-state clobber on the run row (`markFailed` is SQL-guarded
against a `done`/`failed` row, so a `stopRun` racing a just-merged run can't re-mark the run
`failed`). But `RunStateMachine.failRun` still projected the failure onto the BLOCK
unconditionally — so in the same load→`markFailed` window a stop landing right as the merger
flipped the run `done` left `markFailed` correctly no-op'ing while the block was still forced to
`blocked`, resurfacing the "looks failed but the PR merged" inconsistency one layer out. The
block projection now reads the AUTHORITATIVE post-write run status and only drops the block to
`blocked` when the run actually transitioned to `failed`. Runtime-neutral (pure orchestration
logic above the repos); covered by a new `RunStateMachine.failRun` unit test.

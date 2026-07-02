---
---

test(e2e): accept the confirm dialog in reset-run.spec

`#657` made the inspector's "Reset" (discard-run) control confirm-gated via the shared
`ConfirmDialog`, but the `reset-run` e2e spec still clicked `run-reset` and expected the
run to be discarded immediately — so the dialog just sat open, the cancel never fired, and
the task card stayed `blocked` instead of returning to `planned`. This is a deterministic,
main-wide `Test e2e (shard 3)` failure (unrelated to any single feature PR). The spec now
clicks `confirm-accept` to proceed with the cancel.

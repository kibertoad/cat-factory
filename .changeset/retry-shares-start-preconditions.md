---
'@cat-factory/orchestration': patch
---

Fix: a task **retry** and **restart-from-step** now run the same config/resource preconditions
as a fresh **start**, so a re-drive can no longer silently proceed on a configuration a start
would refuse.

`ExecutionService.start`, `.retry` and `.restartFromStep` previously each hand-rolled their
guard sequence, and retry/restart were missing the provider/preset satisfiability check (plus
pipeline-shape, frame-type, tester-infra and agent-backend). So retrying a task whose model
preset can't run every step — e.g. a subscription-only model an inline step (the requirements
reviewer) can't run without an inline harness — skipped the guard and failed mid-run against the
routing default (the confusing "requirements reviewer (qwen:qwen3-max) failed"), instead of the
clear `preset_unsatisfiable` / `providers_unconfigured` refusal a fresh start gives.

The shared preconditions are extracted into one `assertRunnable` method all three entry points
call, so they can't drift again. A retry/restart validates them over the STORED steps it
re-drives (not the current pipeline definition, which may have been edited out of band since the
run started), so the gate reflects exactly what re-executes and a deleted pipeline needs no
special case. The concurrency (task-limit) and dependency gates stay start-only by design (a
retry replaces the failed run rather than adding a new concurrent one).

---
'@cat-factory/contracts': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Preserve a task run's error trail across retries. A failed run's `failure` is now
appended to a new `failureHistory` on the fresh attempt (persisted in the shared
`agent_runs.detail`, so both runtimes get it with no migration), and cleared on the
running attempt — so the top failure banner disappears the moment the task restarts
while every previous error stays viewable in a "previous errors" history on the task
inspector. Applies to both retry (resume-from-failure) and restart-from-step.

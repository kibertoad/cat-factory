---
'@cat-factory/integrations': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
---

Stop two ways a run could sit wedged with nothing left to move it.

A self-hosted runner pool that lost a job now says so. A poll that 404s (or 410s), and a scheduler
status that names a reclaimed runner (`evicted` / `preempted` / `oomkilled` / `node_lost` / …), are
read as the RUNNER going away rather than the job failing, so the step is re-dispatched instead of
burning the run's whole ~70-minute poll budget and dying `timeout`. A job-level failure vocabulary
(`error` / `cancelled` / `timeout` / …) and a success vocabulary (`completed` / `succeeded` / …)
likewise end the poll loop honestly; a status word that matches nothing still keeps the driver
waiting, since wrongly killing a live run is the worse mistake. A pool is asked to route stickily
by job id, so an eviction recovery now dispatches under a FRESH id (as the deploy path already
did) — reusing it would have routed the retry back to the job whose runner just died, making the
recovery a no-op for pool-backed runs.

A manifest that defines no `release` template — or no status path — reports the gap on its
connection test in Settings, and logs it once at registration. Each gap crosses the wire as a
code, so the SPA renders translated copy rather than backend prose.

The merge-review and pipeline-complete notifications are now raised BEFORE the block flips to
`pr_ready`. Raising second meant that if the card failed to raise, the run failed but the task was
already sitting in `pr_ready` with an empty inbox: a PR-ready task with no review action and
nothing to re-drive it.

Breaking for anyone importing them directly: `runnersLogic.mapJobState` is replaced by
`runnersLogic.classifyJobStatus`, which returns `{ state, evicted? }`;
`runnersLogic.manifestWarnings` and `RunnerBackendProvider.warnings` return
`{ code, message }` objects rather than strings. The `(container evicted or crashed)` wording every
transport had copied is now kernel's `CONTAINER_EVICTION_ERROR`.

---
'@cat-factory/integrations': minor
'@cat-factory/orchestration': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Stop two ways a run could sit wedged with nothing left to move it.

A self-hosted runner pool that lost a job now says so. A poll that 404s, and a scheduler status
that names a reclaimed runner (`evicted` / `preempted` / `oomkilled` / `node_lost` / …), are read
as the RUNNER going away rather than the job failing, so the step is re-dispatched onto a fresh
pool member instead of burning the run's whole ~70-minute poll budget and dying `timeout`. A
job-level failure vocabulary (`error` / `cancelled` / `timeout` / …) and a success vocabulary
(`completed` / `succeeded` / …) likewise end the poll loop honestly; a status word that matches
nothing still keeps the driver waiting, since wrongly killing a live run is the worse mistake.
Registering a manifest that defines no `release` template — or no status path — now logs a warning
naming what that costs.

The merge-review and pipeline-complete notifications are now raised BEFORE the block flips to
`pr_ready`. Raising second meant that if the card failed to raise, the run failed but the task was
already sitting in `pr_ready` with an empty inbox: a PR-ready task with no review action and
nothing to re-drive it.

Breaking for anyone importing it directly: `runnersLogic.mapJobState` is replaced by
`runnersLogic.classifyJobStatus`, which returns `{ state, evicted? }`.

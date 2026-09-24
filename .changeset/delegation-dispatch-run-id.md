---
'@cat-factory/delegation-github-actions': patch
---

`start` takes the run id from the dispatch answer. `POST .../dispatches` answers `200` with
`workflow_run_id` and `html_url` on github.com, so a fresh dispatch now returns the real id at once
instead of the correlation key, and no poll has to scan the `workflow_dispatch` page to recover it.
The pre-dispatch lookup by the `run-name:` marker stays, because a replay after a crash between the
dispatch and persisting its answer has only the brief to find its run by, and a server that answers
`204` still falls back to the scan. The `inputs` docs now state Actions' cap of 25 inputs.

---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Public API (`/api/v1`, spec 1.33.0): the merge-EVIDENCE loop. Additive.

Four new operations: `GET /api/v1/runs/:runId/merge-record` (the merge decision a run left behind,
carrying the backend-derived change class, the merger's scores and the preset they were compared
against), `GET /api/v1/merge-records/rollups` (every change class's accumulated track record as one
aggregate), `GET /api/v1/merge-records/:recordId`, and
`POST /api/v1/merge-records/:recordId/effort` (tag or clear the reviewer effort a landed pull
request needed).

Until now the merge track record (ADR 0046) was reachable only from a browser session, which split
the headless story in half: an integration could start a run through `/api/v1` and merge its pull
request through `POST /notifications/:id/act`, and then had nowhere to record how much review that
merge took nor any way to read back what the workspace had accumulated. The one signal the
auto-merge policy is meant to eventually stand on was collectable only by the people who were not
driving the runs.

**Tagging is `write`, not `admin`.** `act` is at the top of the ladder because it merges a pull
request for real; recording how much review an already-landed one took performs no external
side-effect and merges nothing, so an integration whose job is collecting evidence no longer needs a
key that can also delete tasks and merge.

Refusals across the surface carry `error.details.reason`: `run_not_found`, `no_merge_record` (a
readable run whose pipeline reached no merge decision) and `merge_record_not_found`, which the
record-addressed READ and the TAG now answer identically, so a client branches on one value
whichever of the two it called.

`POST /api/v1/notifications/:id/act` deliberately stays body-less, so the app's one-tap
confirm-and-tag has no single-request headless equivalent: every SDK emitter renders a request body
as a required positional parameter, so adding `reviewEffort` there would rewrite `act(id)` as
`act(id, body)` in four published clients. The headless form is two calls in either order, since the
tag is idempotent and orthogonal to the decision.

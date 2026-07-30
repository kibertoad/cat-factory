---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
---

Mothership mode: carry a finished run's telemetry up to the mothership.

Telemetry on a mothership-mode node is captured locally, which until now meant it stayed there: a
hosted teammate opening a run a developer drove saw an empty observability panel, zero token
rollups and no web-search log, and the rows vanished when the node's short retention window came
round. A new machine-authed `POST /internal/telemetry/ingest` (mounted on both facades, gated and
account-scoped exactly like the persistence RPC) accepts a bounded batch of a run's captured rows,
and a background sweep on the node uploads each run once it has gone quiet.

The mothership STAMPS the batch's scope-bound workspace and run onto every row it stores, so a node
can only ever file telemetry for a run in a workspace it can already reach. Appends are idempotent
by row id — a new `recordMany` on the three run-scoped telemetry ports, mirrored across D1, Drizzle
and the local `node:sqlite` store — which is what makes a lost-ack chunk safely retryable.

Note the deliberate asymmetry between `record` and `recordMany`: only the batch append ignores a
duplicate id, because only the batch is retried. A batch over the per-request caps is refused
rather than truncated, since the node treats a success as "this range is stored".

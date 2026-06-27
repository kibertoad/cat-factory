---
'@cat-factory/node-server': patch
---

Update pg-boss `12.21.0 -> 12.23.0`. Purely a dependency bump — the durable-execution
wiring (`PgBossWorkRunner` / `PgBossBootstrapRunner`, the `exclusive` advance queues,
the send options) is unchanged and the public API we use is stable across the bump.

The two internal pg-boss schema migrations (v33/v34) are applied automatically on
`boss.start()`: v33 slims the job-fetch index and adds the background flow-resolver
index (a free query-plan win for our advance queues), and v34 adds dead-letter source
provenance columns (inert for us — we don't configure dead-letter queues; orphaned runs
are recovered by the stale-run sweeper).

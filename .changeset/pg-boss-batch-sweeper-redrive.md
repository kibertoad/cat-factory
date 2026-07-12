---
'@cat-factory/node-server': patch
---

perf(node): batch the sweeper's execution.advance re-drives into one pg-boss insert

The Node stale-run sweeper re-enqueued each run it decides to re-drive with an individual
`boss.send()` — one round-trip per stale run and per resumed spend-paused run, every tick.
It now gathers every `execution.advance` re-drive of a tick (the stale re-drives and the
under-budget spend-paused resumes alike) and flushes them as a single `boss.insert([...])`,
replacing N round-trips with one. Each batch row carries the identical
`singletonKey`/`retryLimit`/`retryDelay`/`retryBackoff`/`expireInSeconds`/`heartbeatSeconds`
options a `send` would, and `insert` dedupes PER ROW against the queue's `exclusive`
`(name, singleton_key)` unique index — so a run that already has a live advance job is a
no-op and the sweeper's no-double-drive guarantee is preserved exactly (verified by a new
real-Postgres test). Bootstrap / env-config-repair re-drives (other queues, typically one at
a time) are unchanged. First implementation slice of the pg-boss ingestion-optimization
initiative (items V1 + B2 + B1).

---
'@cat-factory/local-server': minor
---

Mothership mode: durable SQLite execution work queue (initiative PR 2).

The best-effort in-memory `InProcessWorkRunner` is replaced by the durable `SqliteWorkRunner`,
backed by a file-based `node:sqlite` work queue (default `~/.cat-factory/work-queue.sqlite`,
override with `LOCAL_MOTHERSHIP_WORK_DB`). A mothership-mode local node has no Postgres/pg-boss,
so it drives runs in-process — but the queue now persists the "this run needs driving" intent, so
a crash or restart re-drives what was in flight (boot-time orphan reset + a periodic recovery
poll). It mirrors pg-boss's `exclusive` advance queue (one row per run, mid-drive signal
coalescing, deferred gate re-polls, a poison-attempt cap), reusing the same `executionRuntime()`
timing derivation.

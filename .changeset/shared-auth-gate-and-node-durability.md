---
'@cat-factory/server': minor
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Harden the Node facade and de-duplicate the auth gate (review follow-ups):

- Extract the default-deny session gate + per-workspace authorization into
  `mountAuthGate(app)` in `@cat-factory/server`, so the security-critical middleware
  has ONE implementation instead of being copy-pasted into each runtime facade (the
  Worker and the Node service now both call it). Behaviour is unchanged.
- Node durable execution now actually recovers from crashes: the pg-boss advance job
  carries an `expireInSeconds` sized above a full poll budget plus `retryLimit`, and a
  stale-run sweeper re-enqueues runs left `running` in storage (the analogue of the
  Worker's cron `sweepStuckRuns`). Re-enqueues use the run's `singletonKey`, so a run
  still being driven is never double-driven.
- `start()` shuts down cleanly on SIGTERM/SIGINT: it closes the HTTP server, stops the
  sweeper + pg-boss, releases the pool, then exits (previously the process could hang
  until SIGKILL).
- `TokenUsageRepository.totalsSince` sums into `bigint` instead of `int4`, fixing an
  overflow past ~2.1B tokens and matching the 64-bit totals the D1 store returns.
- `migrate()` runs its `CREATE … IF NOT EXISTS` bootstrap under a transaction-scoped
  advisory lock, so concurrent replica boots can't race on DDL.

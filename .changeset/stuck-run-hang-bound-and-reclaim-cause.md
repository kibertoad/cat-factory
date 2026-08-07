---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': patch
'@cat-factory/local-server': patch
---

Bound a wedged pipeline-step advance on Node, and stop an idle container reclaim from reading as
a crash. The last two findings of the stuck-run audit.

**One hang bound, both facades.** `ExecutionConfig.advanceTimeout` (`ADVANCE_TIMEOUT`, default
`5 minutes`) is now the ceiling on a single `advanceInstance`: the Worker hands it to the
durable driver's `step.do` (where it had been a hard-coded constant), and Node races it in
`driveExecution` through a new injected `DriveOptions.withAdvanceCeiling` seam. Node previously
had no ceiling at all, and nothing else supplies one: pg-boss heartbeats an active job
regardless of handler progress, so a hung call inside an advance left the run `running` with a
frozen `updated_at`, invisible to the stale-run sweeper, until the queue's expire cap (up to
24h). The timeout fails the run as a `timeout` rather than retrying in-process, because a second
concurrent advance would double-drive it.

**A container that reclaims itself says so.** A per-run Cloudflare Container is kept warm only
by the driver's job polls, so a poll gap longer than its idle window reclaimed it mid-job; the
resulting 404 poll was indistinguishable from an OOM and spent the single crash-eviction budget,
so two hiccups in one step failed a healthy run. The container now records the reclaim cause it
observed (`idle` alongside the existing `rollout`) and the transport reads it back over one RPC,
classifying an idle reclaim as `transient` churn with its own operator-facing wording. The two
per-run container classes collapsed onto a shared `RunContainer` base carrying this bookkeeping.

Internal break: the old `rolledOutAt` Durable-Object storage key is gone. A rollout in flight
across the deploy that ships this loses its attribution and is recovered as a crash instead,
which costs one eviction on the smaller budget during a single release.

`DriveConfig` gained a required `advanceTimeoutMs` (`0` disables the ceiling, which is what the
conformance harness and the unit fakes use), so every construction site declares it.

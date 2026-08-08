---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': patch
'@cat-factory/local-server': patch
---

Bound a wedged pipeline step on Node, and stop an idle container reclaim from reading as a
crash. The last two findings of the stuck-run audit.

**One hang bound, both facades.** `ExecutionConfig.advanceTimeout` (`ADVANCE_TIMEOUT`, default
`30 minutes`) is now the ceiling on a single `advanceInstance` AND on a single status read: the
Worker hands it to the durable driver's `step.do` (where it had been a hard-coded constant), and
Node races it in `driveExecution` through a new injected `DriveOptions.withStepCeiling` seam.
Node previously had no ceiling at all, and nothing else supplies one: pg-boss heartbeats an
active job regardless of handler progress, so a hung call left the run `running` with a frozen
`updated_at`, invisible to the stale-run sweeper, until the queue's expire cap (up to 24h). A
timed-out advance fails the run rather than retrying in-process, because a second concurrent
advance would double-drive it; a timed-out poll counts as one unreadable poll against
`jobPollFailureTolerance`, which is the disposition the Worker has always had for the same
event.

**One knob now means one parser.** Every duration knob in `ExecutionConfig` resolves through the
shared `resolveDurationEnv`, which canonicalises the value both runtimes go on to use. Node's
own parser knew four of the units Workflows accepts and silently substituted its built-in
default for the rest, so `ADVANCE_TIMEOUT="1 week"` was a week on Cloudflare and five minutes on
Node. Values past what a timer can hold, and the calendar units whose length the two runtimes
would each have to invent, are refused with one warning rather than honoured differently on each
side.

**A container that reclaims itself says so.** A per-run Cloudflare Container is kept warm only
by the driver's job polls, so a poll gap longer than its idle window reclaimed it mid-job; the
resulting 404 poll was indistinguishable from an OOM and spent the single crash-eviction budget,
so two hiccups in one step failed a healthy run. The container now records the reclaim cause it
observed (`idle` alongside the existing `rollout`) and the transport reads it back over one RPC,
classifying an idle reclaim as `transient` churn with its own operator-facing wording. A record
is claimed by the polling job rather than deleted, so a retried durable poll reads the same
answer, and it is dropped when a new job is accepted, so a marker left by a routine idle reclaim
cannot excuse a later step's genuine crash. The two per-run container classes collapsed onto a
shared `RunContainer` base carrying this bookkeeping.

Internal break: the old `rolledOutAt` Durable-Object storage key is gone. A rollout in flight
across the deploy that ships this loses its attribution and is recovered as a crash instead,
which costs one eviction on the smaller budget during a single release.

`DriveConfig` gained a required `advanceTimeoutMs` (`0` disables the ceiling, which is what the
conformance harness and the unit fakes use), so every construction site declares it.
`ADVANCE_TIMEOUT` is reserved against capability-credential lookup by exact name, not as an
`ADVANCE_` family, so a credential key that merely starts with it stays valid.

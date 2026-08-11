---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/observability-otel': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A run whose stored row cannot be decoded is now closed instead of re-driven forever, and one
unrecoverable run no longer ends the stale-run sweep.

The two are the same incident. A `kind='execution'` row with no `block_id` fails `rowToExecution`,
and every path that could settle such a run begins by READING it: the re-drive throws on the load,
and so does the hard-stall backstop whose entire job is to settle a run recovery cannot resume. The
row therefore stayed `running` forever, was re-listed by every sweep (`listStale` is ordered oldest
first, so it sorted to the front of each one), and past the hard-stall deadline its throw escaped
the per-run body and ended the whole pass: no other stale run recovered, no spend-paused run
resumed, no batch enqueue happened, tick after tick, while the sweeper reported itself as running.

- **Disposal.** `RunStateMachine.loadOrDispose` recognises a `DataIntegrityError` by TYPE (a
  transient database failure still propagates and leaves the run alone) and settles the run through
  `markFailed`, the one write that decodes nothing. Both the driver entry point
  (`ExecutionService.advanceInstance`) and the settle path (`failRun`) read through it, so such a
  row is closed on its first re-drive rather than an hour later.
- **The owning block goes with it.** A settled run row with the card still `in_progress` leaves the
  human half of the incident unresolved forever, because the run is dropped from the board snapshot
  and there is no failure card and no Retry. The run names no block, but the block names the run:
  the new `BlockRepository.getByExecution` reads that reverse link, and the card drops to `blocked`
  with a pushed board event and no fabricated progress.
- **Only a MALFORMED row is disposed of.** A stored value this build does not RECOGNISE is a fact
  about the reader, not the row: during a rolling deploy an unknown `ExecutionStatus` member is a
  healthy run the newer replica wrote, and disposal is irreversible while a re-drive costs a tick.
  `DataIntegrityError` now carries a `DataIntegrityFault`, and the reversible half is the fallback
  wherever the fault is unknown or absent.
- **Isolation.** Both facades' sweeps recover one run at a time inside a per-run boundary, log the
  run they skipped, and count it as `sweep.run_recovery_failed`. A pass that took runs on and
  recovered NONE of them reports itself as a FAILED pass, since such a pass now completes and a
  recorded success would reset `sweep_degraded` on precisely the wedged sweeper it watches for. A
  run whose probe threw keeps its per-process orphan clock, so the hard-stall backstop can still
  reach it.
- **A new failure kind, `state_unreadable`** (surface version 1.48.0, additive), so these runs are
  distinguishable in the operator's failure-kind breakdown rather than filed under `stalled`, whose
  advice is "retry" and whose retry would re-read the same row.
- **A write-side guard.** Composing the stored `detail` for a run that `rowToExecution` would refuse
  now throws, for both invariants it checks (no `blockId`, a cursor outside its step list), so the
  writer that produces one reports the fault instead of a sweeper hours later. Both facades'
  `upsert`/`insertLive`/`compareAndSwap` compose through that one function.

`DataIntegrityError` moved to `@cat-factory/kernel` (re-exported from `@cat-factory/server`, so no
import breaks) because the engine has to be able to recognise it. It also survives the mothership
persistence RPC as its own error code rather than an opaque 500, without which the disposal would be
a no-op on mothership deployments.

Documented on the website in kibertoad/cat-factory-website#53.

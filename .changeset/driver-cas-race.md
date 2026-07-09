---
'@cat-factory/orchestration': patch
'@cat-factory/kernel': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

fix(execution): route the durable driver's writes through optimistic concurrency (race-audit 2.2 driver-half + 2.3)

The durable driver (`RunDispatcher`) loaded a run, made a long outbound call (a container poll up
to 30s / a GitHub gate probe / a deploy provision), then blind-`upsert`ed the whole snapshot — so a
concurrent human action (a CAS'd `requestHumanReviewFix`/`approveStep`/`resolveDecision`) landing in
that window was silently clobbered, and a `cancel()`-deleted run was re-inserted as a zombie.

Every driver write now goes through `RunStateMachine.casPersist` (a `compareAndSwap`, which never
inserts) and throws the internal `RunContendedError` on a lost race; the four driver entry points
(`advanceInstance`/`pollAgentJob`/`pollGate`/`resolveGatePollExhaustion`) catch it and re-drive on
fresh state. The `pollAgentJob` running-fold and `RunDispatcher`'s own follow-up human actions use
`mutateInstance` (reload + re-apply). The terminal-state clobber is closed in both directions on
both runtimes: `RunStateMachine.failRun` now treats `done` as terminal and `markFailed` is
SQL-guarded (`status NOT IN ('done','failed')`), so a `stopRun` racing a just-merged run can't
re-mark it `failed`; and `markFailed` bumps `rev`, so an in-flight driver `casPersist` that loaded
the run before the `stopRun` holds a stale `rev`, misses its CAS guard, re-drives, and no-ops on the
now-`failed` run — it can't resurrect a stopped run as a zombie `running` row. Cross-runtime
conformance asserts the driver can't clobber a concurrent write, resurrect a cancelled run, re-fail a
merged run, or resurrect a stopped run.

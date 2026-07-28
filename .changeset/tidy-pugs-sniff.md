---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
---

Add `ExecutionRepository.countActiveByWorkspace`, the SQL-COUNT capacity read run admission
control checks in front of the durable driver. It counts the same live set `listLive` projects
(`running`/`blocked`/`paused`, scoped to `kind = 'execution'`) over the same
`(workspace_id, kind, status)` index, so no rows cross the wire and none are reduced in JS. Also
allow-listed on the machine persistence RPC, since the read sits on the run-start path.

Both reads now share the new exported `LIVE_EXECUTION_STATUSES` constant on both runtimes, so the
capacity count and the live projection cannot drift apart into a cap checked against a set the
board disagrees with. `insertLive`'s conflict/cleanup predicates deliberately keep their literals:
they mirror the frozen `uniq_live_execution_per_block` index, which is a different invariant.

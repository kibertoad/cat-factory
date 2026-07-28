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

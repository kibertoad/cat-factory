---
'@cat-factory/contracts': minor
'@cat-factory/app': minor
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Connections between services, phase 1 of the service-connections initiative (see
`backend/docs/service-connections.md` + `docs/initiatives/service-connections.md`):

- **Service connections**: a `service`-type frame carries `serviceConnections` — directed
  consumer→provider edges to the other services it uses, each with an optional
  description ("sends transactional email via it"). Stored as a JSON column on the block
  (D1 migration `0034` ⇄ Drizzle), validated at the `updateBlock` write gate (no
  self-connection, no duplicates, targets must be service frames; cycles are deliberately
  legal), pruned when a connected frame is deleted, and drawn as emerald consumer→provider
  edges on the board. A new inspector panel on service frames edits the connections and
  shows the reverse "Used by" list.
- **Per-task involved services**: a task carries `involvedServiceIds` — the connected
  services directly involved in it beyond its own service, picked (in the task's run
  settings) from the frame's connection neighbors in either direction. Validated at the
  write gate against the neighbor set; a selection whose connection was later removed is
  badged stale in the UI and dropped on the next change. Later phases use the selection
  to provision every involved service as an ephemeral environment and to let the coding
  agent change every involved repo (multi-repo sibling checkouts) — designed in the
  docs, not yet implemented.
- Cross-runtime conformance now round-trips both JSON columns and asserts the write-gate
  rejections on both stores.

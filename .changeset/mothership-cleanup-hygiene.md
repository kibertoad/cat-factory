---
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Mothership-mode tech-debt cleanup (functionality-preserving): rename the persistence
allow-list export `PILOT_PERSISTENCE_METHODS` → `REMOTE_PERSISTENCE_METHODS` (it is the
functional surface, no longer a pilot) and drop the unused `accountField` `ScopeRule` kind
that was defined but never allow-listed or exercised. Also refresh stale comments/docs that
predated the Phase-3 merge gate (which is now MET): the `MothershipComposition.repos` JSDoc,
the `buildNodeContainer` `db: undefined` service-matrix note, and the mothership-mode tracker
banner. No runtime behavior change.

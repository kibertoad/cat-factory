---
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

A mothership now serves its per-workspace capability credentials over the persistence RPC. The method was allow-listed but the repository was never reflected into the registry, so a mothership-mode node's capability-credential settings and dispatch-time resolve answered `... is not wired`.

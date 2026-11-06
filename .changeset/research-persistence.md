---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add research persistence on both runtimes: account-published research definitions (immutable per
version), what each research project pins with its atomic findings sequence, findings revisions
(first write wins, inline or offloaded body) and the findings-storage policy tiers. Migrations add
four tables on D1 (`0115_research.sql`) and Postgres. Deleting a project, or the board that homes
it, reclaims its research rows. Nothing writes these yet; the research run does in a later slice.

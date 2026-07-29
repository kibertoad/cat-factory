---
'@cat-factory/node-server': patch
---

Rebase the `dependency_install` migration snapshot onto the current leaf.

`db:check` was failing on `main` with "Non-commutative migrations detected": #1505's
`20260729062615_dependency_install` and #1501's `20260729054610_stiff_jazinda` both carry
`prevIds` pointing at the same pre-merge tip, so drizzle-kit could not order them. Two branches
adding a migration concurrently produce no textual conflict, which is exactly why this lands
after the merge rather than during it.

Fixed the documented way — `scripts/rebase-migration-snapshot.mjs`, which rewrites the later
snapshot's `ddl` from the merged `schema.ts` and re-points `prevIds` at the other leaf. Only
`snapshot.json` changes; `migration.sql` still encodes its own delta (the `dependency_install`
column on `validation_configs`), and the rebased ddl carries both branches' columns. D1 needs no
counterpart — it has no snapshot DAG.

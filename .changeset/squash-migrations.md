---
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Squash the migration lineage on both runtime facades into a single init migration.

Pre-1.0 with no production data to preserve (backwards compatibility is a non-goal),
so the incremental history is collapsed:

- Cloudflare D1 (`@cat-factory/worker`): migrations `0001..0041` become one
  `0001_init.sql` that creates the final schema directly.
- Node Postgres (`@cat-factory/node-server`): the drizzle-kit lineage is regenerated
  from `src/db/schema.ts` into a single migration.

No schema change in either case: each squashed migration is the exact final state of
the prior chain. Existing databases are reset (drop + re-apply) rather than migrated.

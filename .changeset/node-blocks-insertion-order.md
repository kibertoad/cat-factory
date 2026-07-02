---
'@cat-factory/node-server': patch
---

Restore cross-runtime block-ordering parity: the Postgres block repository's list reads
(`listByWorkspace`/`listByService`/`listByServices`) had no `ORDER BY`, so block iteration
order was non-deterministic and diverged from the Cloudflare facade's `ORDER BY rowid`.
The `blocks` table gains a `seq` insert-sequence column (same pattern as `pipelines.seq`)
and all three list reads order by it. Existing rows are backfilled by the migration in
whatever order Postgres returns them (pre-1.0: close enough, self-heals as rows churn).

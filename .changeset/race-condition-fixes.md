---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
---

Fix three concurrency hazards in the backend with database-native primitives.

- **Optimistic concurrency on execution runs.** `agent_runs` gains a monotonic `rev`
  column; the execution repo's `upsert` bumps it on every write and a new
  `compareAndSwap` performs a guarded conditional write. Human-action handlers (resolve
  decision / request changes) now go through a `mutateInstance` retry helper, so a
  double-submit or a write that raced the durable driver is re-applied on fresh state
  instead of silently clobbering the other writer (lost update).
- **Atomic API-key pool lease.** The non-transactional `listForPool → chooseToken →
markLeased` is replaced by a single atomic select-and-mark (`leaseLeastUsed`: Postgres
  `FOR UPDATE SKIP LOCKED`; D1 a single serialised write), so two concurrent dispatches
  can no longer grab the same key before usage is recorded.
- **Notification open-card dedup.** A partial unique index on
  `(workspace_id, block_id, type) WHERE status='open'` plus an atomic
  `upsertOpenForBlock` replaces the racy `findOpenByBlock` read-before-write, so two
  concurrent raises can't stack duplicate open cards.

BREAKING (pre-1.0, no data migration): `agent_runs` adds a non-null `rev` column and the
`notifications` table adds a partial unique index, mirrored across the D1 and Drizzle
migrations. The `ExecutionRepository`, `ProviderApiKeyRepository` and
`NotificationRepository` ports each gain a method.

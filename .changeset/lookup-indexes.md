---
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Add two lookup indexes that were missing for hot single-column queries, mirrored
across both runtimes (D1 migration `0041` ⇄ Drizzle schema + generated migration):

- `services(frame_block_id)` — `getByFrameBlock` resolves a service by frame block
  id alone, with no `account_id` in hand, so it could not use the composite
  `idx_services_frame (account_id, frame_block_id)`. It runs in a loop while walking
  a block's ancestry on every agent run's repo resolution (`resolveRepoTarget`) and on
  board reads, so the previous full table scan was hot.
- `blocks(id)` — `findById` looks a block up by id alone (no `workspace_id`), so it
  could not use the `(workspace_id, id)` primary key and scanned the largest table.

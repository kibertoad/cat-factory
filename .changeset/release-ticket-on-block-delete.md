---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
---

Deleting a task now releases its tracker ticket

A ticket filed as a board task recorded that on `tasks.linked_block_id`, and deleting the block left
the column naming a block that no longer existed. Three readers take a non-null value there to mean
"this issue is spoken for", and none of them checks whether the block is still live: the bug-intake
sweep excluded the ticket from every future search, `claimBlockLink` refused every future filing of
it (naming a task nobody could open), and a comment reply on the ticket routed to the dead block and
bailed. So deleting a filed task took its ticket out of circulation permanently.

The block-delete cascade now clears the link over the whole doomed subtree, through a new batched
`TaskRepository.unlinkAllFromBlocks` implemented on both runtimes. This is the tracker half of the
same fix the document half took: same seam (`removal-cascade.ts`), same rule.

Two visible behaviour changes, both intended:

- **A deleted task's issue returns to the bug-intake candidate pool.** A workspace that has been
  deleting filed tasks will see those issues re-appear as candidates on the next sweep.
- **Re-filing a previously-deleted ticket succeeds** instead of answering `409`
  `ticket_already_linked`.

Nothing is deleted, only unlinked: issue rows, their bodies and their history are untouched, which
is what makes re-filing the right outcome. Rows already carrying a stale link are not healed
retroactively (no migration); they clear on the next delete of the block they name.

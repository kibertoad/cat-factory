---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
---

Close the lost-update race on the iterative-review stores (race-condition audit 2.5).

A requirements / clarity / brainstorm review is ONE JSON blob holding every finding, and every mutation used to load it, edit one item and force-write the whole row back. Two writers inside that window — two people answering different findings, a dismissal landing inside the (slow) incorporation LLM call, the Requirement-Writer's fill pass racing a human accept — left only the last writer's edit. Because incorporation refuses to run while any finding is still `open`, a lost dismissal wedged the loop on a finding that was in fact settled.

- **`rev` + `compareAndSwap` on all three review stores** (D1 migration `0065` ⇄ Drizzle): the conditional write lands only while the stored revision still matches the one the caller read, and never inserts, so a review a fresh run replaced can't be resurrected.
- **Every read-modify-write routes through `mutateReview`** (load → apply → CAS, reloading and RE-APPLYING the mutation on the winner's snapshot when it loses), including the two paths that held a snapshot across an LLM call (`incorporate`, `reReview`) and all four recommendation paths.
- **`deleteByBlock` + `upsert` is replaced by an atomic `replaceForBlock` / `replaceForBlockStage`** (a D1 `batch()` ⇄ a Postgres transaction). Two review runs for one block could previously interleave their delete/insert pairs and leave TWO live reviews, so the window loaded one while the parked run's decision keyed to the other. The racy delete method is removed from the port (and the mothership persistence allow-list) so it can't be reintroduced.

Compatibility break (pre-1.0, no shim): the `RequirementReviewRepository` / `ClarityReviewRepository` / `BrainstormSessionRepository` ports drop `deleteByBlock`/`deleteByBlockStage` and gain `compareAndSwap` + `replaceForBlock`/`replaceForBlockStage`; the review wire shapes gain `rev`. Existing rows read as `rev = 0`, which is exactly what the new column defaults to.

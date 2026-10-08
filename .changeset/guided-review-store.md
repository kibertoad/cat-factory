---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': patch
'@cat-factory/conformance': minor
---

Guided PR review gets its persistence foundation: the session, thread, message and comment-draft contracts, kernel's `GuidedReviewRepository` port, D1 migration 0104 and its Drizzle mirror, and both repositories. Nothing reads or writes the tables yet; the service, the durable answering driver and the routes land in later slices (`docs/initiatives/guided-pr-review.md`).

Concurrent threads write disjoint rows. A thread admits one live answer through a partial unique index, so a second question while one is pending returns `thread_busy` without writing. Driver claims, overview generations and draft posts are conditional writes that report whether they won. Every repository method is `remote` in mothership mode except the cross-workspace stale-job scan, which is a sweeper read.

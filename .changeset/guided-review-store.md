---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': patch
'@cat-factory/conformance': minor
---

Guided PR review gets its persistence foundation: the session, thread, message and comment-draft contracts, kernel's `GuidedReviewRepository` port, D1 migration 0104 and its Drizzle mirror, and both repositories, wired as `CoreDependencies.guidedReviewRepository` on every facade so a mothership serves it to its nodes. No service reads or writes the tables yet; the service, the durable answering driver and the routes land in later slices (`docs/initiatives/guided-pr-review.md`).

Concurrent threads write disjoint rows. A thread admits one live answer through a partial unique index, so a second question while one is pending returns `thread_busy` without writing, and a question on a thread that is missing or belongs to another session returns `thread_not_found`. The store writes the queued state itself (a pending overview on open, a pending placeholder per question), so a caller cannot create work no driver can claim. Driver claims, overview generations and draft posts are conditional writes that report whether they won, and a settle presents the claim it won, so a driver whose lease lapsed cannot land over the driver that took the work over. Every write is checked against the contracts schema the reads decode with, so an oversized outcome is refused at its writer instead of making the thread unreadable; `guidedReviewFailure` builds a failure whose raw detail fits. Every repository method is `remote` in mothership mode except the cross-workspace stale-job scan, which is a sweeper read. Queued work records which host drives it (`deployment` or `node:<nodeId>`), and the stale scan lists only one driver's jobs, so a hosted sweeper never answers a laptop's question with the deployment's credentials. A node recovers its own jobs from its local durable queue.

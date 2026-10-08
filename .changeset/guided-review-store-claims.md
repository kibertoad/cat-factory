---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': minor
---

The guided review store binds every settle to the claim that won it. `claimOverview` and `claimMessage` return a `GuidedReviewClaim` (or null), and `settleOverview`, `settleMessage` and `settleDrafts` require it, so a driver whose lease lapsed cannot land over the driver that took the work over. Every write is checked against the contracts schema the reads decode with, so an oversized outcome is refused at its writer instead of making the thread unreadable; `guidedReviewFailure` builds a failure whose raw detail fits. `settleDrafts` takes `GuidedReviewDraftProposal` and the store fills in the ids it owns. Deleting a session removes threads before messages and drafts on both runtimes, and a node recovers its own jobs from its local durable queue.

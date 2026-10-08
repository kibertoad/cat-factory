---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Guided PR review is reachable from the SPA. `/workspaces/:workspaceId/guided-reviews` opens, lists, reads, refreshes and deletes sessions, and its `threads` sub-routes open threads, ask questions and request comment drafts. Writes return at once; the overview and each answer arrive through a new `guidedReview` workspace event, which carries ids only so a member who is not viewing a review learns nothing more than that it moved. The routes are member tier and only a session's creator may change it.

`ExecutionEventPublisher` gains `guidedReviewChanged`, implemented on the Durable Object, Node and fan-out publishers. Thread routes are addressed under their session, and a thread of another session is answered as absent. The SPA gains the API client and a `guidedReview` store that follows the event. A conformance assertion checks every facade wires the module.

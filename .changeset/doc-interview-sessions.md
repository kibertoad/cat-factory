---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

feat(documents): interactive document-review sessions (doc-task WS5)

Between the outline and the draft, a document-authoring run now converses with the requester
instead of a single binary approve/revise gate. A new inline `doc-interviewer` step (inserted
after `doc-outliner` in `pl_document`, replacing the outline's human gate) asks a small batch of
clarifying questions about scope, audience and structure, parks the run on the standard durable
decision-wait while the human answers through a dedicated window, and iterates (up to a round
cap) until it synthesizes a refined **authoring brief** the `doc-writer`/`doc-finalizer` start
from (folded into their context via the agent-context builder).

Modelled on the initiative interviewer's park/answer/resume spine, but persisted in its own
`doc_interview_sessions` table (a document task has no owning entity row) — mirrored across D1 ⇄
Drizzle with a cross-runtime conformance assertion. The interview window is wired through the
universal result-view seam (`doc-interview`) and updates live over a new `docInterview` workspace
event. Pass-through when no interviewer model is wired, so document pipelines run unchanged.

Breaking: `pl_document` bumps to version 3 (the reseed offer), and its step indices shift (the
interviewer is inserted at index 2), so in-flight runs on the old shape should be restarted.

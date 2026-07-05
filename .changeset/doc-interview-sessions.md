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

The park/answer/resume/advance spine is now a shared `InterviewGateController<TEntity>`
parameterized by an `InterviewGateKind` strategy; both the document interviewer and the
interactive-planning (initiative) interviewer ride it, so the two gates can't drift. A document
task has no owning entity row, so its transcript is persisted in its own `doc_interview_sessions`
table — mirrored across D1 ⇄ Drizzle with a cross-runtime conformance assertion. The interview
window is wired through the universal result-view seam (`doc-interview`) and updates live over a
new `docInterview` workspace event. Pass-through when no interviewer model is wired, so document
pipelines run unchanged.

Hardening: a re-run of a document task now clears the block's prior session before interviewing
(so it starts clean instead of reusing a stale, already-converged one), the converged brief is
folded only into the two kinds that consume it (`doc-writer`/`doc-finalizer`), and a non-final
interviewer pass that returns neither questions nor a brief fails the run loudly instead of
silently skipping the interview with an empty brief.

Breaking: `pl_document` bumps to version 3 (the reseed offer), and its step indices shift (the
interviewer is inserted at index 2), so in-flight runs on the old shape should be restarted.

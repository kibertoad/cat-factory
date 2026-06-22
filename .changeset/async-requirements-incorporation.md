---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Requirements incorporation + re-review now run asynchronously instead of freezing the
review window.

Previously, clicking "Incorporate answers" fired two sequential LLM calls (fold the answers,
then re-review) inside the HTTP request, locking the user in the modal until the round
resolved. Now the request records the human's intent on the parked run, signals the durable
driver, and returns at once with the review in a new transient `incorporating` status. The
fold + re-review run in the same durable driver the rest of the pipeline uses (where the
initial reviewer pass already runs), so the user goes straight back to the board. They are
summoned again — via the existing `requirement_review` notification — only when the
re-review raises new findings (`ready`) or hits the iteration cap (`exceeded`); a converged
re-review (`incorporated`) just advances the pipeline with no interruption.

- **Engine.** The `requirements-review` gate is now re-entrant: a parked gate carrying a
  `pendingIncorporation` marker re-evaluates on wake, runs `incorporate()` + `reReview()`,
  then advances or re-parks. New `ExecutionService.incorporateRequirements` validates the
  findings are settled, flags the review `incorporating`, and signals the driver. An
  off-path inspector review with no parked run still incorporates inline (there is no driver
  to offload to).
- **Live event.** New optional `ExecutionEventPublisher.requirementReviewChanged` +
  `{ type: 'requirements' }` `WorkspaceEvent`, so an open window/inspector tracks the status
  transitions live (Cloudflare pushes via the DO hub; Node reconciles on poll, as today).
- **API.** Incorporation moves to the block-scoped `POST
  /blocks/:blockId/requirement-review/incorporate` (was the reviewId-scoped
  `/requirement-reviews/:reviewId/incorporate`) and returns the `incorporating` review
  rather than `{ review }`.
- **Conformance.** A new cross-runtime assertion proves the async-incorporate route is
  mounted on every facade and refuses incorporation while a finding is unanswered.

Breaking (pre-1.0, no migration): the new `incorporating` review status, the `requirements`
event variant, the transient `pendingIncorporation` field on a pipeline step, and the moved
incorporate endpoint are new wire shapes. Old clients and any in-flight review rows on the
old endpoint shape simply break; stale state is acceptable per the no-backwards-compat
policy.

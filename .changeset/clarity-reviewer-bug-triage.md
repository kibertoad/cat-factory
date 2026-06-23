---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Clarity reviewer (bug-report triage) + bug investigator: a new bug-fix pipeline front.

Adds two new agents at the front of a new `pl_bugfix` ("Triage & fix bug") pipeline preset:

- **`bug-investigator`** — a read-only container agent (it runs the shared `/explore`
  harness path used by `architect`/`analysis`, so no new harness endpoint or image change).
  It clones the repo, reads the codebase from the raw bug report, and returns a prose
  enriched report plus an OPTIONAL working hypothesis — which it omits unless reasonably
  confident, so a low-confidence guess never misdirects the fix. Its output feeds the
  clarity reviewer (the triage subject) and the coder (a non-binding lead, via `priorOutputs`).
- **`clarity-review`** — an inline engine gate step that triages the bug report for
  _fixability_ (repro steps, expected-vs-actual, environment, affected area), mirroring the
  requirements-review iterative loop (raise findings → answer/dismiss → incorporate into one
  standard-format clarified report → re-review until it converges, with the same per-task
  `maxRequirementIterations` / `maxRequirementConcernAllowed` knobs). The converged clarified
  report substitutes downstream as the task description for the spec-writer/coder (when both
  a requirements and a clarity review exist, the requirements doc wins).

Persisted as a new `clarity_reviews` table on BOTH runtimes (D1 migration
`0002_clarity_reviews` + Drizzle migration), wired in both facades' containers with a new
`clarity` event on the real-time transport and a `clarity_review` notification type. A
cross-runtime conformance assertion pins the clarified-brief substitution against both
stores.

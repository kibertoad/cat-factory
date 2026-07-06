---
'@cat-factory/orchestration': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
---

Fix initiative planning interview wedging after "Continue"/"Proceed", and surface a
"Run planning" start control on the initiative board card.

- **Engine:** the step re-park guard in `ExecutionService` never let a _resumed_
  interactive-interviewer step (initiative planning + document interviewer) fall through to
  its gate evaluation — it re-parked the run immediately, so pressing Continue/Proceed
  loaded briefly and then hung on the same questions. The guard (and the generic
  approve/reject guard) now key off a new `interview-gate` agent **trait** carried by both
  interviewer kinds, so a resumed interview (one carrying `pendingInterview`) re-runs the
  interviewer in the durable driver instead of wedging. Trait-based rather than kind-based,
  so a future interviewer needs no engine change.
- **Board:** an initiative card now offers "Run planning" (and, while the interview is
  parked, "Answer planning questions") directly on the board, mirroring a task card's
  on-card Start affordance instead of hiding it behind selecting the block.

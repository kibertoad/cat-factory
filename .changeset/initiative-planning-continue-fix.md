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
  loaded briefly and then hung on the same questions. The guard, the generic approve/reject
  guard, AND the step-handler dispatch in `RunDispatcher` now all key off a new
  `interview-gate` agent **trait** carried by both interviewer kinds — the dispatch routes
  by trait to the controller registered for the step's `agentKind`, so a resumed interview
  (one carrying `pendingInterview`) re-runs the interviewer in the durable driver instead of
  wedging. Fully trait-based rather than kind-based, so a future interviewer just carries the
  trait and wires its controller — no engine branch.
- **Board:** an initiative card now offers "Run planning" (and, while the interview is
  parked, "Answer planning questions") directly on the board, mirroring a task card's
  on-card Start affordance instead of hiding it behind selecting the block. The card and the
  inspector share a single `useInitiativePlanning` composable (no duplicated planning logic):
  the "Answer planning questions" affordance now keys on the interview's parked status alone
  (so it stays reachable once every question is answered but before the human resumes), and
  the optimistic start flag clears the moment the run takes over (so the button can't strand
  itself spinning after a cancel).

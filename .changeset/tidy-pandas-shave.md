---
'@cat-factory/app': patch
---

Surface an initiative's parked plan review on the board, and make the tracker window resolve it.

A `pl_initiative` run parks on the planner's human gate once the plan is drafted, but the board card
kept showing a disabled, spinning "Run planning" and the tracker window (where the planner's park
routes) was read-only — so the gate could only be cleared over REST. The card and the inspector now
carry the same `attention` affordance a task card does (a parked decision, or the plan review),
the interviewer's own park still belonging to "Answer planning questions"; the tracker window gained
the approve / request-changes rail beside the plan it judges; and a frame's decision/approval badge
now counts its initiative children, not only its tasks.

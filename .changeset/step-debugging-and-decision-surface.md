---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/app': minor
---

Step observability + a discoverable iteration-cap decision.

- Every pipeline step now carries the `runId` of the run it belongs to, surfaced on
  the step-detail panel (copyable) so a lone step in a log line or view names its run.
  It is a read-time projection (always equals the enclosing run's id), stamped on read
  and on emit; not persisted independently.
- A step's duration now stops counting once it is terminal OR parked on a human. The
  engine records `pausedAt` when a step parks on an approval / decision / iteration-cap
  gate and clears it when the step resumes or finishes, so elapsed time no longer
  accrues while the run waits for input (the symmetric counterpart of the terminal
  freeze). A step finished directly out of a parked approval is billed to the pause
  instant, not the later human decision.
- An iterative gate that spends its automatic budget (a quality companion at its rework
  cap, or the requirements reviewer at its iteration cap) now raises a
  `decision_required` notification. Previously the three-choice decision was reachable
  only by drilling into the parked step, so the run looked silently stuck; the inbox
  item now opens that step's decision surface (companion → step detail with the
  iteration-cap prompt; requirements → the review window).

No DB migration: the step fields ride in the existing execution `detail` JSON, and the
notification `type` column is free text in both runtimes.

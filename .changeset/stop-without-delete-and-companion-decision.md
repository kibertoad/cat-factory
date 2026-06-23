---
'@cat-factory/app': patch
---

Two task-control improvements on the inspector's execution panel:

- Stop without deleting. The "Stop" button now halts the run but KEEPS it
  (`POST /agent-runs/:id/stop` → `stopRun`): the run stays readable and retryable
  and the block goes `blocked`, instead of the old behaviour that deleted the run
  and reset the task to `planned`. That destructive reset is still available as a
  separate, explicit "Reset" button.
- Surface the companion iteration-cap decision. When a companion (e.g. the Spec
  Reviewer) spends its rework budget it parks for a human, but the inspector showed
  it as a generic "Approve" gate. It now reads "Needs decision" with a distinct
  "Decide" button that opens the three-way iteration-cap prompt (one more round /
  proceed / stop & reset), so the parked decision is no longer mistaken for a plain
  approval or hidden behind the verdict log.

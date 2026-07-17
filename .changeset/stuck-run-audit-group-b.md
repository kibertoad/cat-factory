---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': patch
'@cat-factory/app': minor
---

Stuck-run audit — Group B (invisible parks): make the two remaining silent-park cases
discoverable and stop a recurring fire from discarding a human-parked run.

- **F3 — spend-pause now raises a notification.** A run paused by the spend safeguard is
  invisible to the sweeper and has no auto-resume, so the paused board badge used to be its only
  signal. A new workspace-scoped `budget_paused` notification type is now raised on pause (one card
  per workspace, de-duplicated) and cleared on `resumePaused`, surfacing the pause in the inbox
  where the escalation sweep can flag it. Informational (`act` marks it read; the human raises the
  budget then resumes from the spend panel).
- **F7 — the "waiting for a decision" card is no longer masked by a stale card.**
  `ensureWaitingNotification`'s non-clobbering guard is scoped to the parked run's `executionId`, so
  a leftover `pipeline_complete`/`merge_review`/… card from a PRIOR run can no longer stand in for a
  new `blocked` run's only recovery signal. A richer card for the same run still wins.
- **F10 — a recurring pipeline no longer clobbers a `blocked` prior run.** The overlap guard now
  treats `blocked` (a human-parked review/decision gate) as live alongside `running`/`paused`, so
  the next cadence fire is skipped instead of orphaning the parked run's durable driver.

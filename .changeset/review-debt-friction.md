---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
'@cat-factory/app': minor
---

Opt-in, per-workspace review-debt friction on task creation.

When a workspace enables it, authoring a new task is frictioned while finished work sits unreviewed:
past a soft warn threshold (count of tasks parked on human review) creating a task requires an
explicit acknowledgement, and in `enforce` mode it is refused outright once too many tasks are in
review (by count) or one has waited too long (by age). Off by default — zero behaviour change for
workspaces that don't enable it.

- **Debt is derived from the existing open-notification signal** — no new "in review" state. A new
  closed `REVIEW_WAIT_NOTIFICATION_TYPES` constant + the pure `assessReviewFriction` verdict live in
  `@cat-factory/contracts`, so the SPA pre-warns with the SAME function the backend enforces with.
- **Enforced server-side** in `BoardService.addTask` behind optional settings/notifications seams
  (pass-through when unwired or off); a `review_debt_warn` / `review_debt_blocked` 409 drives the
  friction dialog, and an acknowledgement can never tunnel through a hard block.
- **Four new `workspace_settings` fields** (mode + warn count + two nullable hard-block triggers),
  mirrored across D1 and Drizzle with cross-runtime conformance coverage.
- **Frontend**: a "Review friction" settings group, the friction dialog (with a "go review" deep
  link), a pre-warn debt badge on the add-task affordance, and copy localized in every locale.

Full design: `backend/docs/review-debt-friction.md`.

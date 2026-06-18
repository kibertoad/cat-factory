---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': minor
---

Real merge lifecycle: CI gate + CI-fixer, merger agent, and notifications.

A task now becomes `done` only when its pull request is **actually merged** on
GitHub — fixing the bug where a task showed "merged" (and a green board) from a
confidence score alone, while CI was red and the PR still open.

- **CI gate (`ci` step)** — auto-inserted before the merger in the standard
  pipelines. It polls the PR head's GitHub check runs and, on failure, dispatches a
  new **`ci-fixer`** container agent that pushes a fix to the PR branch, looping up
  to a configurable budget (default 10) until CI is green; polling stops the moment
  CI goes green. If the budget is spent it raises a `ci_failed` notification.
- **Merger agent (`merger` step)** — runs last. A container agent scores the PR's
  complexity / risk / impact, and the engine compares those against the task's
  **merge threshold preset** to either auto-merge (a real GitHub merge) or raise a
  `merge_review` notification for a human. Presets are a per-workspace library
  (selectable per task); the CI-fixer attempt budget lives on the preset.
- **`merger` is appended to the standard pipelines.** A pipeline with no merger now
  raises a `pipeline_complete` notification on completion (confirm + merge) instead
  of silently marking the task done.
- **Notifications** — a new first-class, human-actionable board surface (inbox +
  events), modelled behind a `NotificationChannel` port so email/Slack delivery can
  be added later without touching the call sites. In-app delivery only for now.

Adds migration `0024_merge_lifecycle.sql` (notifications + merge-preset tables, the
`blocks.merge_preset_id` column). The executor-harness image gains `/ci-fix` and
`/merge` endpoints (version bumped so the GHCR image is re-tagged).

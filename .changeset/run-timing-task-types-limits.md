---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Rework run timing, add task types, and add a per-service running-task limit.

**Run timing.** A run parked waiting for a human is no longer auto-failed after a
fixed timeout — it waits indefinitely. The old `decision_timeout` machinery is gone
(the Cloudflare driver re-arms its `waitForEvent` instead of failing; the Node driver
drops the decision-timeout queue/worker; the `decision_timeout` failure kind is
removed). Instead, notifications carry a `severity` and a periodic sweep escalates any
open notification from `normal` (yellow) to `urgent` (red, "Overdue") once it has
waited past the workspace's `waitingEscalationMinutes` threshold. Every human-input
park now also guarantees an open notification, so a waiting run is never silently
stuck. **Breaking:** the `decision_timeout` agent-failure kind is removed.

**Task types.** Tasks gain a `taskType` (`feature` / `bug` / `document` / `spike` /
`recurring`) chosen at creation, plus small per-type fields (e.g. a bug's severity /
repro, a spike's time-box). `recurring` is created through the existing recurring-
pipeline schedule flow, which now also accepts a free-text prompt for its reused task.

**Per-service running-task limit.** A new per-workspace settings object
(`waitingEscalationMinutes` + a task-limit policy) caps how many tasks may run
concurrently under one service — off, a single shared bucket, or one bucket per task
type. Starting a task over the limit is refused with a human-readable 409. Managed via
`GET|PUT /workspaces/:ws/settings` and a new Workspace settings panel. Persisted in a
new `workspace_settings` table on both runtimes (D1 ⇄ Drizzle), with cross-runtime
conformance assertions for the task type round-trip and the limit enforcement.

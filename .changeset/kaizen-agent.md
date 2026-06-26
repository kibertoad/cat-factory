---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Add the Kaizen agent: a post-run, continuous-improvement reviewer (toggleable per
workspace, never a pipeline-builder step) that grades each completed agent step on how
smooth/efficient vs confused/chaotic the interaction was and recommends prompt/model
improvements.

- After a run completes, the engine schedules a grading per completed agent step
  (skipping verified combos); a background sweep (Cloudflare cron / Node interval) runs
  the inline LLM grade. The grader's model is configured in Model Configuration like
  every other agent (the hidden-from-palette `kaizen` kind).
- A `(promptVersion, agentKind, model)` combo that grades 5/5 with no recommendations
  five times in a row is marked **verified** and is no longer graded.
- New persisted tables `kaizen_gradings` + `kaizen_verified_combos` (D1 ⇄ Drizzle parity,
  asserted by a new cross-runtime conformance suite) and a per-workspace `kaizenEnabled`
  setting (a new `workspace_settings.kaizen_enabled` column).
- New read API (`GET /workspaces/:ws/kaizen`, `GET /workspaces/:ws/executions/:id/kaizen`),
  a `kaizen` real-time event, a Kaizen screen (grading history + verified combos), and
  per-step grading status (scheduled/running/complete + results) inside the run window —
  never on the board.

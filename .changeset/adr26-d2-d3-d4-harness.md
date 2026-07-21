---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Make a parallel-subagent review observable and correctly metered (ADR 0026 D2.1/D3/D4).

- D2.1: the Claude Code runner now derives slice progress from the parent stream's `Task`
  dispatches + their tool_results (which DO appear there), so a subagent-driven review no
  longer sits at 0% — per-slice progress surfaces without a parent TodoWrite plan.
- D3: a best-effort watcher tails the CLI's `subagents/*.jsonl` transcripts while the run is
  live, feeding the inactivity heartbeat (so a quiet-but-alive review stops looking wedged)
  and summing each subagent turn's token usage into the run's `usage` + per-call telemetry —
  the subagent cost that was previously invisible.
- D4: a short cold-start watchdog (`JOB_COLD_START_MS`, default 120s, 0 to disable) records a
  structured diagnostic when a job produces no output early — without killing it — plus a
  one-line assertion that the pre-seeded onboarding keys landed, logged with the CLI version.

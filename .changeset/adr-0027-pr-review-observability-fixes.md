---
'@cat-factory/executor-harness': patch
'@cat-factory/agents': patch
---

fix(pr-review observability): close ADR 0027 Defect A + Defect B for the parallel-subagent shape

Both mechanisms ADR 0026 shipped for a `Task`-parallelised PR review were defeated on the exact
shape they targeted. ADR 0027 confirmed the root causes; this closes them.

- **Defect A — subagent token usage never counted.** The watcher was pointed at
  `<configHome>/subagents`, which the Claude CLI never creates — it writes each parallel subagent's
  transcript per-session under `<configHome>/projects/<encoded-cwd>/<session-uuid>/subagents/*.jsonl`.
  `startSubagentWatcher` now takes the `projects` root and DISCOVERS the `subagents/` dirs by walking
  (the session uuid isn't known before the CLI mints it), summing every `subagents/*.jsonl` turn's
  usage while deliberately EXCLUDING the sibling parent session transcript (whose usage the terminal
  `result` event already totals) so the parent is never double-counted. A harness fixture test now
  lays the tree out exactly as the CLI writes it.

- **Defect B — progress pinned at 0%.** The slice-tracker fallback was gated off by `sawTodoPlan`,
  but the pr-reviewer prompt makes the CLI write its todo plan ONCE at grouping time and then fan the
  review out across parallel subagents that never mark the plan done — so the todo source sat at 0/N
  and the very fallback meant to cover the parallel shape was disabled. The gate is gone: a new pure
  `pickProgress` reconciles the two redundant views on every update, preferring whichever is further
  along (more completed, then more in-flight, then richer), so live in-flight `Task` slices surface as
  progress and a stale todo plan can no longer mask them. The pr-reviewer prompt is corrected to say
  progress is surfaced from the todo list AND from parallel subagent dispatches.

The executor-harness image tag is bumped for the `src/**` change (Defect A + B live in the harness).

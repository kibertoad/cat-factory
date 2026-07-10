---
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Perf: roll up per-step LLM metrics only on step-boundary/terminal emits, not on every progress fold (performance-optimizations item 1).

- `RunStateMachine.emitInstance` now takes a `{ rollUpMetrics }` option (default `true`). The
  metrics rollup is a per-agent-kind GROUP BY over the whole run's `llm_call_metrics`, so running
  it on every emit made the drive loop pay O(emits × calls-in-run) — the frequent progress-only
  poll folds (a subtask tick or a streamed follow-up while a container runs) re-aggregated the run
  just to redraw a progress bar. The two running-progress poll folds in `RunDispatcher`
  (`pollAgentJobInner`'s container fold and `pollDeployerJob`'s deploy fold) now pass
  `rollUpMetrics: false`; the rollup refreshes only on the emits that surface a settled step.
- `step.metrics` is live-only, derived state (never persisted; absent from the snapshot), so the
  SPA execution store now carries the last-known per-step rollup forward when an incoming instance
  omits it (`upsert`/`hydrate`), per the live-push coherence rules — a metric-less running fold no
  longer blanks the board's per-step metrics bar between boundaries. Pinned with store-level unit
  tests.

-- The PHASE and TURN axes on per-call LLM telemetry (token-burn instrumentation, slice 2 —
-- docs/initiatives/token-burn-instrumentation.md).
--
-- Without them a run's spend is one undifferentiated pile per agent kind, so "the pipeline does
-- work a small task never needed" (a pre-PR validation repair round, a reproduction-proof repair
-- round) cannot be told apart from the agent's own edit loop. `phase` is stamped by whoever owns
-- the boundary — the harness, which drives those loops — and rides the metric; it is never
-- reconstructed downstream from timestamps.
--
-- `phase` defaults to '' (the unattributed slice: a REAL group in the rollup, never a dropped
-- row), so rows written by an older harness image are correct rather than merely missing.
-- `turn_index` is NULLABLE on purpose: it is the harness's job-scoped `seq`, and the proxy path
-- has no job-scoped counter at all. A 0 there would read as "the first turn" and quietly sort
-- every proxied call to the front of its phase.
--
-- No backfill and no index: this table is pruned to LLM_CALL_METRICS_RETENTION_DAYS, so
-- pre-axis rows churn out within the window, and the per-execution rollup already
-- rides idx_llm_call_metrics_execution.
ALTER TABLE llm_call_metrics ADD COLUMN phase TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_call_metrics ADD COLUMN turn_index INTEGER;

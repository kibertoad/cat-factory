-- Split the single lumped `cached_prompt_tokens` into the two classes it was hiding, and
-- redefine `prompt_tokens` as FRESH input only, so the three input classes are orthogonal and
-- additive (total input = prompt + cache_read + cache_write).
--
-- A cache READ is ~0.1x base input; a cache WRITE is 1.25-2x base input, i.e. dearer than
-- fresh. Summed together, a repair loop that keeps invalidating and re-writing the prefix is
-- indistinguishable from one riding a warm cache — which is exactly the attribution the
-- token-burn instrumentation needs (docs/initiatives/token-burn-instrumentation.md).
--
-- The old column is DROPPED rather than dual-read: backwards compatibility is a non-goal, and
-- this table is pruned to LLM_CALL_METRICS_RETENTION_DAYS, so the rows whose
-- `prompt_tokens` still carries the old inclusive semantics churn out within the window. No
-- backfill is attempted for the same reason — and because the split genuinely cannot be
-- recovered from one summed number.
ALTER TABLE llm_call_metrics ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_call_metrics ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_call_metrics DROP COLUMN cached_prompt_tokens;

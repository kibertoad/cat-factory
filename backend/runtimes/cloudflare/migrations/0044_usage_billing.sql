-- Usage & quota tracking (Part A): extend the spend ledger to also count subscription
-- harness usage (Claude Code / Codex / GLM / pooled Kimi & DeepSeek), which flat-rate
-- quota plans previously kept out of `token_usage`.
--
-- `billing` discriminates a real metered per-token cost (summed by the budget gate) from a
-- flat-rate subscription call (counted for the usage report but EXCLUDED from every spend
-- rollup — the `totalsSince*` queries filter `billing = 'metered'`). Existing rows are all
-- metered, so the column defaults to 'metered'. `vendor` is the subscription vendor for a
-- subscription row (null for metered).
ALTER TABLE token_usage ADD COLUMN billing TEXT NOT NULL DEFAULT 'metered';
ALTER TABLE token_usage ADD COLUMN vendor TEXT;

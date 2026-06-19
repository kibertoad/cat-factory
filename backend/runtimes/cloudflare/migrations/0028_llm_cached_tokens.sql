-- Track prompt tokens served from the provider's prompt cache, so the dashboard can
-- show the actual cache hit rate (input tokens dominate container-agent spend, and
-- the stable re-sent prefix should increasingly be a cache hit rather than re-billed).
ALTER TABLE llm_call_metrics ADD COLUMN cached_prompt_tokens INTEGER NOT NULL DEFAULT 0;

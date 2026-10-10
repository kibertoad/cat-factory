-- What the AGENT DRY RUN's dispatch RESOLVED, persisted so the durable poll can be handed it back
-- instead of working it out again. Mirrored on Node by the Drizzle `environmentTestRuns` table.
--
-- The poll runs in a fresh process (and possibly a second worker) and rebuilds its handle from this
-- row alone, which is the same constraint that makes a pipeline step persist the identical pair
-- (`recordDispatchAttribution`). Both columns are NULL in `provision` mode and until the prober's
-- container is accepted; they are written together with `probe_dispatched_at`.

-- The model the container actually ran, as `provider:model`. Re-resolving it at poll time answers
-- about the frame and the preset AS THEY ARE NOW, so a pin cleared (or a preset switched) while the
-- container worked would stamp the settled report with a model the run never ran -- and that label
-- is what an operator judges the verdict's weight by.
ALTER TABLE environment_test_runs ADD COLUMN probe_model TEXT;

-- The pooled subscription token the dispatch leased, when it leased one. It has no second source:
-- the lease happens once, at dispatch, and this is the row the settled job's tokens are attributed
-- back to for usage-aware rotation. NULL for a proxy-metered Pi job, and for a PERSONAL
-- (individual-usage) credential, which is not pooled -- that run's quota is counted against
-- `initiated_by` instead.
ALTER TABLE environment_test_runs ADD COLUMN probe_subscription_token_id TEXT;

-- The subscription VENDOR that model runs on, when there is one. Recorded rather than parsed back
-- out of `probe_model`, because the vendor slug differs from the model's provider for four of the
-- five (`claude` vs `anthropic`, `codex` vs `openai`, `glm` vs `zai`, `kimi` vs `moonshot`) and it
-- is the vendor a quota cycle is keyed on. NULL for a proxy-metered Pi job.
ALTER TABLE environment_test_runs ADD COLUMN probe_subscription_vendor TEXT;

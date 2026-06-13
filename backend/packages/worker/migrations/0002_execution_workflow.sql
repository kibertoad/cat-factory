-- Durable execution support. `updated_at` is a lease the cron sweeper uses to
-- find runs that are still `running` but whose Workflows instance has died;
-- `error` records an agent failure that survived the per-step retries;
-- `workflow_instance_id` records the durable instance driving the run (equal to
-- the execution id today, stored explicitly so that can change without a schema
-- change). Existing rows default safely so tick-mode is unaffected.

ALTER TABLE executions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE executions ADD COLUMN error TEXT;
ALTER TABLE executions ADD COLUMN workflow_instance_id TEXT;

-- Supports the sweeper's "running + stale lease" scan.
CREATE INDEX idx_executions_running_lease ON executions (status, updated_at);

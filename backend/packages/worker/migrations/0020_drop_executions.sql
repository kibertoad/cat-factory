-- Execution runs now live in the unified `agent_runs` table (migration 0019) as
-- `kind='execution'` rows, owned by D1ExecutionRepository. Drop the legacy
-- `executions` table — clean break, no data migration (dev DB).

DROP TABLE IF EXISTS executions;

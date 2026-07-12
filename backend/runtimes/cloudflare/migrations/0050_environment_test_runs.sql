-- Ephemeral-environment self-test runs: a developer-triggered diagnostic that exercises a
-- service frame's provisioning config end to end against a throwaway branch (create branch →
-- provision → tear down → delete branch) and reports success or the stage it failed at. It has
-- its own table (not `agent_runs`) because it carries a `stage` state machine and is not a
-- container agent. Mirrored on Node by the Drizzle `environmentTestRuns` table.
CREATE TABLE IF NOT EXISTS environment_test_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  initiated_by TEXT,
  branch TEXT,
  environment_id TEXT,
  env_url TEXT,
  error TEXT,
  failed_stage TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The snapshot loads a workspace's in-flight runs; the driver/sweeper reads running runs.
CREATE INDEX IF NOT EXISTS idx_environment_test_runs_ws_status
  ON environment_test_runs (workspace_id, status);

-- Unify the two container-backed agent flows — "bootstrap repo" runs and task
-- pipeline "execution" runs — onto a single `agent_runs` table that is the source
-- of truth for run lifecycle, live subtask progress, structured failure and
-- retry. This is the cross-cutting concern both flows duplicated; folding them
-- into one table lets the board surface failure + retry uniformly and lets one
-- cron sweeper re-drive any stale run (fixing the previously-missing bootstrap
-- sweeper). Conventions per 0001/0010: workspace-scoped, INTEGER epoch-ms
-- timestamps, no foreign keys.
--
-- Clean break (dev DB): the old `bootstrap_jobs` table is dropped here and the
-- old `executions` table in 0020 (no data is migrated). `reference_architectures`
-- is unaffected.
--
--   kind      — 'bootstrap' | 'execution'; every query is scoped by it so the two
--               flows share storage without colliding.
--   block_id  — the board block this run is attached to. Nullable: a bootstrap run
--               is inserted before its provisional service frame exists; an
--               execution run always has its task block.
--   status    — fine-grained run status (running | blocked | paused | succeeded |
--               done | failed). Kept top-level (not buried in `detail`) because the
--               sweeper scans `status='running'` and must NOT re-drive blocked
--               (awaiting decision) or paused (spend gate) runs.
--   detail    — kind-specific structural JSON nothing queries on:
--               execution  {pipelineId, pipelineName, steps, currentStep}
--               bootstrap  {referenceArchitectureId, referenceArchitectureName,
--                           repoName, repoOwner, repoUrl, instructions}
--   subtasks  — JSON {completed,inProgress,total} run-level progress (bootstrap's
--               todo counts). Execution keeps per-step counts inside detail.steps.
--   failure   — JSON-encoded AgentFailure {kind,message,detail,hint,occurredAt,
--               lastSubtasks} when a run faults; NULL otherwise.
--   updated_at— refreshed on every write; doubles as the sweeper's lease.

CREATE TABLE agent_runs (
  workspace_id          TEXT    NOT NULL,
  id                    TEXT    NOT NULL,
  kind                  TEXT    NOT NULL,
  block_id              TEXT,
  status                TEXT    NOT NULL,
  detail                TEXT    NOT NULL DEFAULT '{}',
  subtasks              TEXT,
  error                 TEXT,
  failure               TEXT,
  workflow_instance_id  TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_agent_runs_workspace    ON agent_runs (workspace_id, created_at);
CREATE INDEX idx_agent_runs_status_lease ON agent_runs (status, updated_at);
CREATE INDEX idx_agent_runs_block        ON agent_runs (workspace_id, block_id);

DROP TABLE IF EXISTS bootstrap_jobs;

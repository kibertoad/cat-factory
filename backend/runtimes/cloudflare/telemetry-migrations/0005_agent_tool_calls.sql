-- Tool-call trajectory sink (see the kernel `agent-tool-calls` port). One row per tool
-- invocation an agent made, in the order it made them — what the agent DID, beside the
-- `llm_call_metrics` account of what each model call cost and the `agent_context_snapshots`
-- account of what it was given. Lives in the dedicated telemetry database (TELEMETRY_DB) and
-- is pruned by the retention sweep to the same LLM_CALL_METRICS_RETENTION_DAYS window.
--
-- `args`/`result` are captured (scrubbed + capped) only when the deployment's prompt recording
-- AND the workspace's storeAgentContext both allow it; `bodies` records which, so a withheld
-- body never reads as a tool that took no arguments.
CREATE TABLE agent_tool_calls (
  id             TEXT    NOT NULL PRIMARY KEY,
  workspace_id   TEXT    NOT NULL,
  execution_id   TEXT    NOT NULL,
  agent_kind     TEXT    NOT NULL,
  job_id         TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  tool           TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL,
  ok             INTEGER NOT NULL DEFAULT 1,
  bodies         TEXT    NOT NULL DEFAULT 'withheld',
  args           TEXT    NOT NULL DEFAULT '',
  result         TEXT    NOT NULL DEFAULT '',
  args_dropped   INTEGER NOT NULL DEFAULT 0,
  result_dropped INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
-- The trajectory read: one run's calls in the order the agent made them. `started_at` and not
-- `created_at`, which is stamped once per DRAIN so a whole poll window shares it; `seq` breaks
-- the ties, because a tool loop routinely fires several calls inside one millisecond. NOT
-- `job_id`, which is a string (`<executionId>-<agentKind>[-<epoch>]`) and would order a run's
-- dispatches by agent-kind spelling.
CREATE INDEX idx_agent_tool_calls_trajectory
  ON agent_tool_calls (workspace_id, execution_id, started_at, seq);
-- The keyset page the debug fan-out lists share, with `job_id` leading so the one-dispatch
-- drill-down is served by the same index rather than a scan of the run.
CREATE INDEX idx_agent_tool_calls_execution
  ON agent_tool_calls (workspace_id, execution_id, created_at);
CREATE INDEX idx_agent_tool_calls_job
  ON agent_tool_calls (workspace_id, execution_id, job_id, created_at);
-- The retention prune's access path (a global range delete, not workspace-scoped).
CREATE INDEX idx_agent_tool_calls_created ON agent_tool_calls (created_at);

-- Supporting index for the lean live-run projection `ExecutionRepository.listLive`
-- (`SELECT id, block_id, status ... WHERE workspace_id = ? AND kind = 'execution' AND status IN
-- ('running','blocked','paused')`), which backs the per-service task-concurrency dispatch guard
-- and `resumePaused`. The pre-existing indexes — (workspace_id, created_at), (status, updated_at),
-- (workspace_id, block_id), (service_id) — serve neither: none leads on (workspace_id, kind,
-- status). Mirrored on Node by idx_agent_runs_ws_kind_status on the Drizzle `agent_runs` table.
CREATE INDEX idx_agent_runs_ws_kind_status ON agent_runs (workspace_id, kind, status);

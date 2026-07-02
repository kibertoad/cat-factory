-- Enforce "at most ONE live execution run per block" atomically. `start`/`retry`/
-- `restartFromStep` upheld this only at the app level via delete-then-insert with the
-- NON-unique idx_agent_runs_block, so two genuinely concurrent starts (double-click, a
-- recurring fire racing a manual start, a notification retry racing a human retry) could
-- both insert a live row — two durable drivers, two containers, on one branch. This
-- partial unique index makes the guard a single atomic write (see
-- D1ExecutionRepository.insertLive's ON CONFLICT (workspace_id, block_id) … DO NOTHING).
-- Partial, so terminal (`done`/`failed`) history is unconstrained; scoped to
-- kind='execution' so the bootstrap flow's rows on the same block never collide.
CREATE UNIQUE INDEX uniq_live_execution_per_block
  ON agent_runs (workspace_id, block_id)
  WHERE kind = 'execution' AND status IN ('running', 'blocked', 'paused');

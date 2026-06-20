-- In-org shared services, step 2: denormalise `service_id` onto the board's hot path so the
-- next step can re-key the physical scope from workspace to service. Migration 0030 created
-- the account-owned `services` (one per top-level frame, id = workspace_id || ':' || frame_id)
-- and the `workspace_services` mounts. Here we stamp every block and agent_run with the
-- service it belongs to.
--
-- This step is deliberately additive and backward-compatible: the column is nullable and the
-- primary keys are unchanged, so the existing workspace_id-scoped repositories keep working
-- verbatim. A follow-up migration flips the primary keys to (service_id, id) together with the
-- service-scoped repository ports.

ALTER TABLE blocks ADD COLUMN service_id TEXT;
ALTER TABLE agent_runs ADD COLUMN service_id TEXT;

-- A block's service is the service of its top-level frame ancestor. Climb parent_id to the
-- root (parent_id IS NULL) and derive the service id the same way migration 0030 did.
WITH RECURSIVE anc(workspace_id, id, root_id, parent_id) AS (
  SELECT workspace_id, id, id AS root_id, parent_id FROM blocks
  UNION ALL
  SELECT a.workspace_id, a.id, b.id AS root_id, b.parent_id
  FROM anc a
  JOIN blocks b ON b.workspace_id = a.workspace_id AND b.id = a.parent_id
)
UPDATE blocks SET service_id = (
  SELECT a.workspace_id || ':' || a.root_id
  FROM anc a
  WHERE a.workspace_id = blocks.workspace_id AND a.id = blocks.id AND a.parent_id IS NULL
);

-- An agent_run (execution or bootstrap) inherits the service of its target block.
UPDATE agent_runs SET service_id = (
  SELECT b.service_id
  FROM blocks b
  WHERE b.workspace_id = agent_runs.workspace_id AND b.id = agent_runs.block_id
);

CREATE INDEX idx_blocks_service ON blocks (service_id);
CREATE INDEX idx_agent_runs_service ON agent_runs (service_id);

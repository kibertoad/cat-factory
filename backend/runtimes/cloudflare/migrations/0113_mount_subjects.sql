-- A board mounts account-owned SUBJECTS, of which a service is one kind. The block and run owner
-- stamp names the owning subject rather than a service, and the mount table names its subject.
-- SQLite rewrites the indexes on a renamed column; they are recreated under names that match.

ALTER TABLE blocks RENAME COLUMN service_id TO owner_id;
DROP INDEX IF EXISTS idx_blocks_service;
CREATE INDEX idx_blocks_owner ON blocks (owner_id);

ALTER TABLE agent_runs RENAME COLUMN service_id TO owner_id;
DROP INDEX IF EXISTS idx_agent_runs_service;
CREATE INDEX idx_agent_runs_owner ON agent_runs (owner_id);

ALTER TABLE workspace_services RENAME TO workspace_mounts;
ALTER TABLE workspace_mounts RENAME COLUMN service_id TO subject_id;
DROP INDEX IF EXISTS idx_workspace_services_service;
CREATE INDEX idx_workspace_mounts_subject ON workspace_mounts (subject_id);

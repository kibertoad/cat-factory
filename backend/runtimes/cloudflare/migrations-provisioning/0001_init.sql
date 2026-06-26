-- Separate D1 database for the unified provisioning event log (binding
-- PROVISIONING_DB), isolating its high write churn from the main DB. One row per
-- attempt to spin up / tear down throwaway infrastructure across the environment +
-- runner-pool/container subsystems, with the verbatim provider/runtime error on
-- failure. Mirrors the Node facade's `provisioning` Postgres schema.

CREATE TABLE provisioning_log (
  id            TEXT    NOT NULL PRIMARY KEY,
  workspace_id  TEXT    NOT NULL,
  subsystem     TEXT    NOT NULL,   -- 'environment' | 'runner-pool' | 'container'
  operation     TEXT    NOT NULL,   -- 'provision'|'teardown'|'status'|'dispatch'|'release'|'poll-failure'
  target_id     TEXT,               -- environment id / run id / job id
  provider_id   TEXT,
  block_id      TEXT,
  execution_id  TEXT,
  outcome       TEXT    NOT NULL,   -- 'success' | 'failure'
  error         TEXT,               -- verbatim provider/runtime error on a failure
  detail        TEXT,               -- optional structured context (JSON)
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_provisioning_log_workspace ON provisioning_log (workspace_id, created_at);
CREATE INDEX idx_provisioning_log_subsystem ON provisioning_log (workspace_id, subsystem, created_at);
CREATE INDEX idx_provisioning_log_execution ON provisioning_log (workspace_id, execution_id, created_at);
CREATE INDEX idx_provisioning_log_target ON provisioning_log (workspace_id, target_id);
CREATE INDEX idx_provisioning_log_created ON provisioning_log (created_at);

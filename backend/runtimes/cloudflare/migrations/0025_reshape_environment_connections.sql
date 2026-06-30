-- Per-service provision type + per-type infra handlers (slice 2b, breaking).
-- See docs/initiatives/per-service-provision-types.md.
--
-- Reshape `environment_connections` from a single per-workspace provider binding (keyed by
-- (workspace_id, provider_id), discriminated by `kind`) into a multi-row per-provision-type
-- HANDLER table keyed by (workspace_id, provision_type, manifest_id): a workspace declares
-- one handler per provision type, plus one per pinned custom `manifest_id`. `manifest_id` is
-- '' for the non-custom types so it sits in the composite primary key cleanly (the repos map
-- '' ⇄ null). `manifest_json` is renamed `handler_json` (it now carries the engine
-- connection, sans secrets; the manifests to apply come from the service at provision time).
--
-- Backwards compatibility is NOT a goal (CLAUDE.md): this is a clean DROP/CREATE, so any
-- pre-reshape connection rows are dropped and must be re-registered.
DROP TABLE IF EXISTS environment_connections;
CREATE TABLE environment_connections (
  workspace_id        TEXT    NOT NULL,
  provision_type      TEXT    NOT NULL,        -- kubernetes | docker-compose | custom
  manifest_id         TEXT    NOT NULL DEFAULT '', -- custom manifest id ('' for non-custom)
  engine              TEXT    NOT NULL,        -- local-docker | local-k3s | remote-kubernetes | remote-custom
  backend_kind        TEXT    NOT NULL,        -- env-backend registry kind that builds the provider
  provider_id         TEXT    NOT NULL,
  label               TEXT    NOT NULL,
  base_url            TEXT    NOT NULL,
  handler_json        TEXT    NOT NULL,        -- serialized InfraHandlerConfig (sans secrets)
  accepts_manifest_id TEXT,                    -- for remote-custom: the manifest id it accepts
  secrets_cipher      TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  PRIMARY KEY (workspace_id, provision_type, manifest_id)
);
CREATE INDEX idx_environment_conn_workspace
  ON environment_connections (workspace_id)
  WHERE deleted_at IS NULL;

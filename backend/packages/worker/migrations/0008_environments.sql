-- Ephemeral environment provider integration: a workspace's binding to its own
-- self-rolled environment management API (described by a declarative manifest),
-- and the registry of environments that have been provisioned from it.
--
-- Conventions follow the existing schema (0001/0004/0005): aggregates are scoped
-- by workspace, timestamps are INTEGER epoch-ms, there are no foreign keys, and a
-- soft-delete `deleted_at` tombstone with a partial unique index lets a workspace
-- re-register without the binding colliding.
--
-- Credentials are stored as opaque ciphertext (AES-256-GCM via SecretCipher),
-- never plaintext: `secrets_cipher` holds the per-tenant management-API secret
-- bundle; `access_cipher` holds a provisioned env's own access creds; and
-- `provision_fields_cipher` holds the fields captured at provision time that
-- status/teardown calls interpolate.

-- At most one *live* environment provider per workspace.
CREATE TABLE environment_connections (
  workspace_id    TEXT    NOT NULL,
  provider_id     TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  base_url        TEXT    NOT NULL,
  manifest_json   TEXT    NOT NULL,
  secrets_cipher  TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  PRIMARY KEY (workspace_id, provider_id)
);
-- A workspace registers at most one live provider. Partial so a tombstoned
-- binding doesn't block re-registering the workspace with a new provider.
CREATE UNIQUE INDEX idx_environment_conn_workspace
  ON environment_connections (workspace_id)
  WHERE deleted_at IS NULL;

-- One row per provisioned environment.
CREATE TABLE environments (
  id                       TEXT    NOT NULL PRIMARY KEY,
  workspace_id             TEXT    NOT NULL,
  block_id                 TEXT,
  execution_id             TEXT,
  provider_id              TEXT    NOT NULL,
  external_id              TEXT,
  url                      TEXT,
  status                   TEXT    NOT NULL,
  access_cipher            TEXT,
  provision_fields_cipher  TEXT,
  created_at               INTEGER NOT NULL,
  expires_at               INTEGER,
  last_error               TEXT,
  deleted_at               INTEGER
);
-- Discovery: the live environment provisioned for a board block (consumed by the
-- execution engine to enrich downstream tester context).
CREATE INDEX idx_environments_block
  ON environments (workspace_id, block_id)
  WHERE deleted_at IS NULL;
-- TTL sweep: the cron tears down environments whose expiry has elapsed.
CREATE INDEX idx_environments_expiry
  ON environments (expires_at)
  WHERE deleted_at IS NULL AND expires_at IS NOT NULL;

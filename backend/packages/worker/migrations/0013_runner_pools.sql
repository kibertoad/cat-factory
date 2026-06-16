-- Self-hosted runner-pool integration ("bring your own infra"): a workspace's
-- binding to its own container runner pool's scheduler API (described by a
-- declarative manifest), used instead of per-run Cloudflare Containers for the
-- repo-operating coding jobs.
--
-- Conventions follow the existing schema (esp. 0008_environments): aggregates are
-- scoped by workspace, timestamps are INTEGER epoch-ms, there are no foreign keys,
-- and a soft-delete `deleted_at` tombstone with a partial unique index lets a
-- workspace re-register without the binding colliding.
--
-- The per-tenant scheduler-API secret bundle is stored as opaque ciphertext
-- (AES-256-GCM via SecretCipher), never plaintext, in `secrets_cipher`. There is
-- no per-job table: the execution engine already tracks each job durably and the
-- pool is addressed by the cat-factory job id, so poll/release need no extra row.

-- At most one *live* runner pool per workspace.
CREATE TABLE runner_pool_connections (
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
-- A workspace registers at most one live pool. Partial so a tombstoned binding
-- doesn't block re-registering the workspace with a new pool.
CREATE UNIQUE INDEX idx_runner_pool_conn_workspace
  ON runner_pool_connections (workspace_id)
  WHERE deleted_at IS NULL;

-- Generalize the post-release-health connection from Datadog-specific to a pluggable
-- observability provider (Datadog is the only adapter today). The connection is keyed by
-- `provider` and stores a single sealed `credentials` JSON blob (provider-specific) plus a
-- non-secret `summary` blob for display. Pre-1.0, no migration of old rows — the prior
-- `datadog_connections` table is dropped and re-created fresh under the new shape.
DROP TABLE IF EXISTS datadog_connections;

CREATE TABLE observability_connections (
  workspace_id TEXT    NOT NULL,
  provider     TEXT    NOT NULL,
  -- Sealed by the facade's SecretCipher (domain tag 'cat-factory:observability').
  credentials  TEXT    NOT NULL,
  -- Non-secret display fields, e.g. {"site":"datadoghq.com"} for Datadog.
  summary      TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id)
);

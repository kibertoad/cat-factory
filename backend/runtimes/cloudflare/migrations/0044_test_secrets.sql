-- Sensitive per-service test credentials (sealed). The SEALED sibling of the non-sensitive
-- test-credential pools: a third-party API token a Tester needs, sealed at rest by the
-- SecretCipher (tag 'cat-factory:test-secrets') and delivered to the Tester container out of
-- band (injected as env vars, never in a prompt/telemetry). Keyed by the SERVICE FRAME block,
-- exactly like release_health_configs. See docs/initiatives/tester-environment-access.md.
CREATE TABLE test_secrets (
  workspace_id TEXT    NOT NULL,
  block_id     TEXT    NOT NULL,   -- the service frame block these secrets belong to
  credentials  TEXT    NOT NULL,   -- sealed JSON of TestSecretEntry[] (key + description + value)
  summary      TEXT    NOT NULL DEFAULT '[]',  -- non-secret JSON of TestSecretRef[] (key + description)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, block_id)
);

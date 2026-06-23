-- Post-release-health gate (Datadog). Adds the two merge-preset knobs that bound the
-- gate (how long it watches a deployed release's monitors/SLOs, and how many on-call
-- investigations it may dispatch), and the two tables backing the integration: the
-- per-workspace Datadog connection (credentials sealed at rest) and the per-block
-- monitor/SLO mapping the gate reads. Mirrors the Drizzle schema in runtimes/node.

ALTER TABLE merge_threshold_presets
  ADD COLUMN release_watch_window_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE merge_threshold_presets
  ADD COLUMN release_max_attempts INTEGER NOT NULL DEFAULT 1;

-- One Datadog connection per workspace. `api_key`/`app_key` are stored encrypted by the
-- facade's SecretCipher (domain tag 'cat-factory:datadog'); plaintext only in memory.
CREATE TABLE datadog_connections (
  workspace_id TEXT    NOT NULL,
  site         TEXT    NOT NULL,
  api_key      TEXT    NOT NULL,
  app_key      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id)
);

-- Per-block (service frame) monitor/SLO mapping the post-release-health gate reads.
CREATE TABLE release_health_configs (
  workspace_id    TEXT    NOT NULL,
  block_id        TEXT    NOT NULL,
  monitor_ids     TEXT    NOT NULL DEFAULT '[]',
  slo_ids         TEXT    NOT NULL DEFAULT '[]',
  env_tag         TEXT,
  bugsnag_project TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, block_id)
);

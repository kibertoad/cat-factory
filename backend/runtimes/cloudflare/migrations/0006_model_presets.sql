-- Model presets: a named, per-workspace set of model->agent mappings. A preset is one
-- `base_model_id` applied to every agent kind plus per-kind `overrides` (JSON object,
-- agentKind -> model id). Exactly one preset per workspace is the default. A task
-- selects one via `blocks.model_preset_id`; none -> the workspace default preset.
--
-- This REPLACES the old per-agent-kind `workspace_model_defaults` map (dropped below).
-- Pre-1.0, no data migration: a fresh workspace re-seeds the built-in presets (Kimi
-- K2.7 default + GLM-5.2) on first read.
CREATE TABLE model_presets (
  workspace_id  TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  base_model_id TEXT    NOT NULL,
  overrides     TEXT    NOT NULL DEFAULT '{}',
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_model_presets_default ON model_presets (workspace_id, is_default);

-- The per-task model preset selection.
ALTER TABLE blocks ADD COLUMN model_preset_id TEXT;

-- The per-agent-kind default map is superseded by presets.
DROP TABLE IF EXISTS workspace_model_defaults;

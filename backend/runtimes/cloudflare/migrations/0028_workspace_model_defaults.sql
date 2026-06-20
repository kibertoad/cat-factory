-- Per-workspace, per-agent-kind default model selection.
--
-- A workspace can choose which model is the default for each agent kind (e.g.
-- point `architect` at a strong model and `tester` at a cheap one), overriding the
-- env-driven `AGENT_routing` for that workspace at run time. One row per (workspace,
-- agent kind); a kind absent for a workspace falls back to the env routing.
--
-- Resolution precedence at run time is: a block's explicitly pinned model wins,
-- else this workspace per-kind default, else the env routing for the kind, else the
-- env default.

CREATE TABLE workspace_model_defaults (
  workspace_id TEXT    NOT NULL,
  agent_kind   TEXT    NOT NULL,
  model_id     TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_kind)
);

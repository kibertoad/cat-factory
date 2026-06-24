-- Per-WORKSPACE enabled GATEWAY models (the dynamic catalog subset). A gateway provider
-- (OpenRouter today; LiteLLM and others later) is a single OpenAI-compatible endpoint to
-- many models reached via the workspace's API-key pool. Rather than a hardcoded handful, a
-- workspace browses the gateway's live catalog and enables a subset. `models` is a JSON
-- array of the enabled models, each with its cached context window + per-1M-token price (in
-- the spend currency) so the picker and budget have them without a live fetch. Keyed by
-- (workspace_id, provider) so a new gateway reuses this table rather than adding its own.
CREATE TABLE provider_model_catalog (
  workspace_id TEXT NOT NULL,
  provider     TEXT NOT NULL,        -- gateway provider id: openrouter | litellm | …
  models       TEXT NOT NULL,        -- JSON array of { id, name, contextLength?, inputPerMillion, outputPerMillion }
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);

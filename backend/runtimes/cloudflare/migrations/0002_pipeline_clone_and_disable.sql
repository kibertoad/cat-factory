-- Pipeline cloning + per-step disable.
--   enabled: nullable JSON array of per-step enable flags, parallel to agent_kinds.
--            A step whose flag is false is kept in the pipeline but skipped at run start.
--   builtin: 1 for the curated seedPipelines() catalog templates (read-only — clone to
--            edit), NULL for user-created and cloned pipelines.
ALTER TABLE pipelines ADD COLUMN enabled TEXT;
ALTER TABLE pipelines ADD COLUMN builtin INTEGER;

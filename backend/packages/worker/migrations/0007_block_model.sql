-- Per-block selection of the LLM model to run its agents with. Stored as the
-- catalog model id (TEXT); resolved to a concrete provider/model at run time
-- (see MODEL_CATALOG in @cat-factory/core). Nullable: existing blocks have no
-- selection and fall back to the agent routing's default model.
ALTER TABLE blocks ADD COLUMN model_id TEXT;

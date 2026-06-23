-- Capture the model's reasoning / "thinking" trace alongside the response text.
-- A reasoning model (e.g. @cf/moonshotai/kimi-k2.7-code) can spend its whole output
-- budget thinking and return an empty completion; without this column those output
-- tokens were unaccounted for (response_text empty, no trace). Mirrored on Node by the
-- Drizzle `reasoning_text` column.
ALTER TABLE llm_call_metrics ADD COLUMN reasoning_text TEXT NOT NULL DEFAULT '';

-- Per-step human approval gates on a pipeline definition. `gates` is a nullable
-- JSON array of booleans, parallel to `agent_kinds`: when `gates[i]` is true the
-- run pauses after step `i` completes so a human can review (and edit) that
-- step's proposal before the next step runs. NULL (legacy rows) means no gates,
-- so existing pipelines keep running straight through.

ALTER TABLE pipelines ADD COLUMN gates TEXT;

-- Pipeline builder improvements: per-step estimate gating + library organization.
--
-- `pipelines.gating`   — JSON array of per-step StepGating, parallel to agent_kinds.
--                        An enabled entry makes the step run only when the task
--                        estimate meets the threshold (else it is skipped at runtime).
--                        Used today to make a companion (reviewer / architect-companion /
--                        spec-companion) conditional on how heavy the task is.
-- `pipelines.labels`   — JSON array of free-form organizational labels (filter/search).
-- `pipelines.archived` — 1 when the pipeline is hidden from the default library view.

ALTER TABLE pipelines ADD COLUMN gating TEXT;
ALTER TABLE pipelines ADD COLUMN labels TEXT;
ALTER TABLE pipelines ADD COLUMN archived INTEGER;
